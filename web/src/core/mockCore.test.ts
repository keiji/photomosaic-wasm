import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeGrid, createMockCore, DEFAULT_BLOCK_SIZE } from './mockCore';
import type { RgbaImage } from './types';

describe('computeGrid(グリッド計算: 詳細設計書 4.2)', () => {
  it('割り切れるサイズでは半端ブロックなし', () => {
    expect(computeGrid(240, 120, 24)).toEqual({
      width: 240,
      height: 120,
      blockSize: 24,
      cols: 10,
      rows: 5,
      totalBlocks: 50,
    });
  });

  it('割り切れないサイズでは右端・下端が半端ブロックになり ceil で計算される', () => {
    expect(computeGrid(100, 100, 24)).toMatchObject({ cols: 5, rows: 5, totalBlocks: 25 });
    expect(computeGrid(101, 103, 24)).toMatchObject({ cols: 5, rows: 5, totalBlocks: 25 });
  });

  it('極端な縦長・横長でも cols/rows は独立に計算される', () => {
    expect(computeGrid(4096, 10, 24)).toMatchObject({ cols: 171, rows: 1 });
    expect(computeGrid(10, 4096, 24)).toMatchObject({ cols: 1, rows: 171 });
  });

  it('ブロック数が 1 になるケース(画像 < block_size 相当)', () => {
    expect(computeGrid(10, 10, 24)).toMatchObject({ cols: 1, rows: 1, totalBlocks: 1 });
  });

  it('不正な入力はエラーになる', () => {
    expect(() => computeGrid(0, 10, 24)).toThrow();
    expect(() => computeGrid(10, 10, 0)).toThrow();
  });
});

describe('createMockCore(論理 API)', () => {
  it('getVersion が文字列を返す', async () => {
    const core = createMockCore();
    expect(await core.getVersion()).toContain('mock-core');
  });

  it('setMainImage でグリッドが確定し、全体ブロック数を返す', async () => {
    const core = createMockCore();
    const image = {
      width: 320,
      height: 240,
      data: new Uint8ClampedArray(320 * 240 * 4),
    };
    const grid = await core.setMainImage(image);
    expect(grid).toEqual({
      width: 320,
      height: 240,
      blockSize: DEFAULT_BLOCK_SIZE,
      cols: 14, // ceil(320 / 24)
      rows: 10, // ceil(240 / 24)
      totalBlocks: 140,
    });
  });

  it('setBlockSize でグリッドが再計算される', async () => {
    const core = createMockCore();
    const image = {
      width: 320,
      height: 240,
      data: new Uint8ClampedArray(320 * 240 * 4),
    };
    await core.setMainImage(image);
    const grid = await core.setBlockSize(8);
    expect(grid).toMatchObject({ blockSize: 8, cols: 40, rows: 30, totalBlocks: 1200 });
  });

  it('メイン画像未設定で setBlockSize / exportImage はエラーになる', async () => {
    const core = createMockCore();
    await expect(core.setBlockSize(24)).rejects.toThrow();
    await expect(core.exportImage()).rejects.toThrow();
  });

  it('exportImage はメイン画像の RGBA を返す(エクスポート経路の確認用)', async () => {
    const core = createMockCore();
    const image = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
      ]),
    };
    await core.setMainImage(image);
    const exported = await core.exportImage();
    expect(exported.width).toBe(2);
    expect(exported.height).toBe(2);
    expect(Array.from(exported.data)).toEqual(Array.from(image.data));
  });
});

describe('タイルプール(論理 API: handoff/04 M3)', () => {
  const feature32 = (r: number, g: number, b: number): RgbaImage =>
    makeImage(32, 32, [r, g, b, 255]);

  it('addTile でタイルが登録され、枚数・メモリ量が更新される', async () => {
    const core = createMockCore();
    const info = await core.addTile(0n, feature32(255, 0, 0), makeImage(64, 32, [255, 0, 0, 255]));
    expect(info.id).toBe(0n);
    expect(info.thumbWidth).toBe(64);
    expect(info.thumbHeight).toBe(32);
    expect(core.getTileCount()).toBe(1);
    expect(core.getTilesMemoryBytes()).toBe(64 * 32 * 4);
  });

  it('同一 id の追加は置き換えになり、メモリ量が二重計上されない', async () => {
    const core = createMockCore();
    await core.addTile(1n, feature32(255, 0, 0), makeImage(64, 64, [255, 0, 0, 255]));
    await core.addTile(1n, feature32(0, 0, 255), makeImage(32, 32, [0, 0, 255, 255]));
    expect(core.getTileCount()).toBe(1);
    expect(core.getTilesMemoryBytes()).toBe(32 * 32 * 4);
  });

  it('removeTile でタイルが削除され、存在しない id はエラーになる', async () => {
    const core = createMockCore();
    await core.addTile(1n, feature32(255, 0, 0), makeImage(64, 64, [255, 0, 0, 255]));
    await core.removeTile(1n);
    expect(core.getTileCount()).toBe(0);
    expect(core.getTilesMemoryBytes()).toBe(0);
    await expect(core.removeTile(1n)).rejects.toThrow();
  });

  it('clearTiles でプールが空になる', async () => {
    const core = createMockCore();
    await core.addTile(1n, feature32(255, 0, 0), makeImage(64, 64, [255, 0, 0, 255]));
    await core.addTile(2n, feature32(0, 255, 0), makeImage(64, 64, [0, 255, 0, 255]));
    core.clearTiles();
    expect(core.getTileCount()).toBe(0);
    expect(core.getTilesMemoryBytes()).toBe(0);
  });

  it('詳細 detail は単色で 0、コントラストで大きくなる', async () => {
    const core = createMockCore();
    const flat = await core.addTile(
      1n,
      feature32(128, 128, 128),
      makeImage(32, 32, [128, 128, 128, 255]),
    );
    expect(flat.detail).toBe(0);

    // 左半分黒・右半分白の特徴量サムネイル
    const data = new Uint8ClampedArray(32 * 32 * 4);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const v = x < 16 ? 0 : 255;
        const offset = (y * 32 + x) * 4;
        data[offset] = v;
        data[offset + 1] = v;
        data[offset + 2] = v;
        data[offset + 3] = 255;
      }
    }
    const contrast = await core.addTile(
      2n,
      { width: 32, height: 32, data },
      makeImage(32, 32, [128, 128, 128, 255]),
    );
    expect(contrast.detail).toBeGreaterThan(40);
  });
});

/** 単色 RGBA バッファを生成する */
function flatTile(
  width: number,
  height: number,
  pixel: [number, number, number, number],
): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = pixel[0];
    data[offset + 1] = pixel[1];
    data[offset + 2] = pixel[2];
    data[offset + 3] = pixel[3];
  }
  return data;
}

/** 単色画像を生成する */
function makeImage(
  width: number,
  height: number,
  pixel: [number, number, number, number],
): RgbaImage {
  return { width, height, data: flatTile(width, height, pixel) };
}

describe('生成(モック: 行バッチ単位 M5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** タイル 1 枚を登録済みのコアを生成する */
  const coreWithTile = (): ReturnType<typeof createMockCore> => {
    const core = createMockCore();
    core.setMainImage(makeImage(24, 1200, [10, 20, 30, 255])); // cols=1, rows=50
    void core.addTile(
      1n,
      makeImage(32, 32, [128, 128, 128, 255]),
      makeImage(64, 64, [0, 0, 0, 255]),
    );
    return core;
  };

  it('run が進捗(match / compose)と行バッチ部分結果を発火する', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    const core = coreWithTile();

    const progress: { phase: string; assigned: number }[] = [];
    const batches: { begin: number; end: number; length: number }[] = [];
    core.onProgress((event) =>
      progress.push({ phase: event.phaseCode, assigned: event.assignedBlocks }),
    );
    core.onResult((batch) =>
      batches.push({
        begin: batch.blockRowBegin,
        end: batch.blockRowEnd,
        length: batch.rgba.length,
      }),
    );

    const done = core.run();
    await vi.advanceTimersByTimeAsync(5000);
    await done;

    // 進捗: フェーズごとのイベントが届く(match 中は割当数が単調増加)
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((e) => e.phase === 'match')).toBe(true);
    expect(progress.some((e) => e.phase === 'compose')).toBe(true);
    const last = progress.at(-1);
    if (!last) return;
    expect(last.assigned).toBe(1 * 50); // cols=1 / rows=50

    // 部分結果: 行を欠かず結合するとメイン画像全体になる(モックは行コピー)
    expect(batches.length).toBe(Math.ceil(50 / 8));
    let rows = 0;
    for (const batch of batches) {
      expect(batch.begin).toBe(rows);
      rows = batch.end;
      // 画素行数 = (end - begin) * blockSize(最終バッチはクリップ)
    }
    expect(rows).toBe(50);
    const lastBatch = batches.at(-1);
    if (!lastBatch) return;
    // 最終バッチ: ブロック行 48..50 → 画素行 1152..1200(48 行)
    expect(lastBatch.length).toBe(24 * (50 * 24 - 48 * 24) * 4);
  });

  it('cancel で run が中断し、以降の部分結果が発火しない', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    const core = coreWithTile();

    let batches = 0;
    core.onResult(() => {
      batches += 1;
    });

    const done = core.run();
    await vi.advanceTimersByTimeAsync(300); // match フェーズ(112ms)を越えて合成に入る
    core.cancel();
    const batchesAtCancel = batches;
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(batchesAtCancel).toBeGreaterThan(0);
    expect(batches).toBe(batchesAtCancel);
  });
});
