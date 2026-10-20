/**
 * 純 TypeScript コアの結合テスト。
 * WASM 版と同等の論理 API・行バッチ・差分再マッチ・設定・メトリクスを確認する。
 */
import { describe, expect, it } from 'vitest';
import { createJsCore } from './jsCore';
import type { ProgressEvent, ResultBatch, RgbaImage } from './types';

const featureThumb = (r: number, g: number, b: number): RgbaImage => {
  const data = new Uint8ClampedArray(32 * 32 * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  }
  return { width: 32, height: 32, data };
};

const composeThumb = (w: number, h: number, rgb: [number, number, number]): RgbaImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = rgb[0];
    data[offset + 1] = rgb[1];
    data[offset + 2] = rgb[2];
    data[offset + 3] = 255;
  }
  return { width: w, height: h, data };
};

const redBlueMain = (): RgbaImage => {
  const width = 48;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const rgb: [number, number, number] = x < 24 ? [255, 0, 0] : [0, 0, 255];
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
};

const patternMain = (width: number, height: number): RgbaImage => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const v = (x * 7 + y * 13) % 256;
      data[offset] = v;
      data[offset + 1] = v;
      data[offset + 2] = v;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
};

const center = (image: RgbaImage, x: number, y: number): [number, number, number] => {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset] as number,
    image.data[offset + 1] as number,
    image.data[offset + 2] as number,
  ];
};

describe('純 TypeScript コア', () => {
  it('P1: グリッドとブロック平均色を返す', async () => {
    const core = createJsCore();
    const grid = await core.setMainImage({
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]),
    });
    expect(grid).toEqual({
      width: 2,
      height: 2,
      blockSize: 24,
      cols: 1,
      rows: 1,
      totalBlocks: 1,
    });
    expect(Array.from(core.getBlockMeanColors())).toEqual([255, 0, 0]);
  });

  it('P1: setBlockSize でグリッドと平均色数が更新される', async () => {
    const core = createJsCore();
    await core.setMainImage({
      width: 4,
      height: 4,
      data: new Uint8ClampedArray(4 * 4 * 4),
    });
    const grid = await core.setBlockSize(2);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(2);
    expect(grid.totalBlocks).toBe(4);
    expect(core.getBlockMeanColors().length).toBe(4 * 3);
  });

  it('P2: タイル解析結果とメモリ量を返す', async () => {
    const core = createJsCore();
    const info = await core.addTile(1n, featureThumb(255, 0, 0), composeThumb(64, 32, [255, 0, 0]));
    expect(info.id).toBe(1n);
    expect(info.thumbWidth).toBe(64);
    expect(info.thumbHeight).toBe(32);
    expect(info.usage).toBe(0);
    expect(info.meanLab[0]).toBeCloseTo(53.24, 1);
    expect(info.meanLab[1]).toBeCloseTo(80.09, 1);
    expect(info.meanLab[2]).toBeCloseTo(67.2, 1);
    expect(info.detail).toBeCloseTo(0, 4);
    expect(core.getTileCount()).toBe(1);
    expect(core.getTilesMemoryBytes()).toBe(64 * 32 * 4);
  });

  it('run: メイン画像とタイルからフォトモザイクを生成する', async () => {
    const core = createJsCore();
    const main = redBlueMain();
    await core.setMainImage(main);
    await core.addTile(1n, featureThumb(255, 0, 0), composeThumb(64, 64, [255, 0, 0]));
    await core.addTile(2n, featureThumb(0, 0, 255), composeThumb(64, 64, [0, 0, 255]));
    await core.run();

    const exported = await core.exportImage();
    expect(exported.width).toBe(48);
    expect(exported.height).toBe(24);
    for (let offset = 3; offset < exported.data.length; offset += 4) {
      expect(exported.data[offset]).toBe(255);
    }
    expect(center(exported, 12, 12)[0]).toBeGreaterThan(200);
    expect(center(exported, 36, 12)[0]).toBeLessThan(55);
  });

  it('run: 進捗と部分結果をバッチ順に返し、結合すると export と一致する', async () => {
    const width = 96;
    const height = 768;
    const core = createJsCore();
    await core.setMainImage(patternMain(width, height));
    await core.addTile(1n, featureThumb(120, 120, 120), composeThumb(64, 64, [120, 120, 120]));

    const events: ProgressEvent[] = [];
    const batches: ResultBatch[] = [];
    core.onProgress((event) => events.push(event));
    core.onResult((batch) => batches.push(batch));
    await core.run();

    expect(events.length).toBeGreaterThan(0);
    const phases = new Set(events.map((event) => event.phaseCode));
    expect(phases.has('match')).toBe(true);
    expect(phases.has('compose')).toBe(true);
    const last = events[events.length - 1];
    expect(last?.assignedBlocks).toBe(4 * 32);
    expect(last?.overallRatio).toBeCloseTo(1.0, 5);

    expect(batches.length).toBe(4);
    let row = 0;
    for (const batch of batches) {
      expect(batch.blockRowBegin).toBe(row);
      row = batch.blockRowEnd;
      expect(batch.blockSize).toBe(24);
      expect(batch.width).toBe(width);
      expect(batch.rgba.length).toBe(width * (batch.blockRowEnd - batch.blockRowBegin) * 24 * 4);
    }
    expect(row).toBe(32);

    const exported = await core.exportImage();
    let offset = 0;
    for (const batch of batches) {
      for (const byte of batch.rgba) {
        expect(exported.data[offset]).toBe(byte);
        offset += 1;
      }
    }
    expect(offset).toBe(exported.data.length);
  });

  it('cancel: バッチ境界で停止し、現時点までの状態を保持する', async () => {
    const core = createJsCore();
    await core.setMainImage(patternMain(96, 384));
    await core.addTile(1n, featureThumb(120, 120, 120), composeThumb(64, 64, [120, 120, 120]));

    const running = core.run();
    core.cancel();
    await running;
    const exported = await core.exportImage();
    expect(exported.data.length).toBe(96 * 384 * 4);
  });

  it('rematch: タイル追加後に差分再マッチして出力が追従する', async () => {
    const core = createJsCore();
    await core.setConfig({ ...(await core.getConfig()), no_reuse: false });
    await core.setMainImage(redBlueMain());
    await core.addTile(1n, featureThumb(40, 0, 0), composeThumb(64, 64, [40, 0, 0]));
    await core.run();
    const before = await core.exportImage();

    await core.addTile(2n, featureThumb(0, 0, 255), composeThumb(64, 64, [0, 0, 255]));
    await core.rematch();
    const after = await core.exportImage();
    expect(Array.from(after.data)).not.toEqual(Array.from(before.data));
    expect(center(after, 36, 12)[0]).toBeLessThan(55);
  });

  it('no_reuse: 似た特徴量のタイルを1回だけ使い、余ったブロックは背景にする', async () => {
    const core = createJsCore();
    await core.setMainImage({
      width: 48,
      height: 48,
      data: new Uint8ClampedArray(48 * 48 * 4),
    });
    await core.addTile(1n, featureThumb(255, 0, 0), composeThumb(64, 64, [255, 0, 0]));
    await core.addTile(2n, featureThumb(0, 0, 255), composeThumb(64, 64, [0, 0, 255]));

    await core.run();
    let exported = await core.exportImage();
    let transparentBlocks = 0;
    for (let by = 0; by < 2; by++) {
      for (let bx = 0; bx < 2; bx++) {
        const offset = ((by * 24 + 12) * 48 + (bx * 24 + 12)) * 4;
        if (exported.data[offset + 3] === 0) {
          transparentBlocks += 1;
        }
      }
    }
    expect(transparentBlocks).toBe(2);

    await core.setConfig({ ...(await core.getConfig()), no_reuse: false });
    await core.run();
    exported = await core.exportImage();
    transparentBlocks = 0;
    for (let by = 0; by < 2; by++) {
      for (let bx = 0; bx < 2; bx++) {
        const offset = ((by * 24 + 12) * 48 + (bx * 24 + 12)) * 4;
        if (exported.data[offset + 3] === 0) {
          transparentBlocks += 1;
        }
      }
    }
    expect(transparentBlocks).toBe(0);
  });

  it('config: 既定値の往復と範囲外エラー', async () => {
    const core = createJsCore();
    const config = await core.getConfig();
    expect(config.w_c).toBe(1.0);
    expect(config.no_reuse).toBe(true);
    expect(config.row_batch).toBe(8);

    await core.setConfig({ ...config, color_correct: 0.5, row_batch: 4 });
    const updated = await core.getConfig();
    expect(updated.color_correct).toBe(0.5);
    expect(updated.row_batch).toBe(4);

    await expect(core.setConfig({ ...config, color_correct: 1.5 })).rejects.toThrow(
      /color_correct/,
    );
    await expect(core.setConfig({ ...config, improve_margin: 0.4 })).rejects.toThrow(
      /improve_margin/,
    );
    await expect(core.setConfig({ ...config, duplicate_de: 0.4 })).rejects.toThrow(/duplicate_de/);
    await expect(core.setConfig({ ...config, duplicate_detail: 40 })).rejects.toThrow(
      /duplicate_detail/,
    );
    await expect(core.setConfig({ ...config, main_blend: 0.9 })).rejects.toThrow(/main_blend/);
    await expect(core.setConfig({ ...config, neighbor_de: 1.5 })).rejects.toThrow(/neighbor_de/);
    await expect(core.setConfig({ ...config, no_reuse: 1 as unknown as boolean })).rejects.toThrow(
      /no_reuse/,
    );
    // 失敗した set は既存設定を壊さない
    expect((await core.getConfig()).color_correct).toBe(0.5);
  });

  it('metrics: run 完了後にフェーズ・スパン・メモリを返す', async () => {
    const core = createJsCore();
    await core.setMainImage({
      width: 48,
      height: 24,
      data: new Uint8ClampedArray(48 * 24 * 4),
    });
    await core.addTile(1n, featureThumb(200, 200, 200), composeThumb(64, 64, [200, 200, 200]));
    await core.run();
    const metrics = await core.getMetrics();
    expect(metrics.length).toBe(1);
    const run = metrics[0];
    expect(run?.trigger).toBe('tile_added');
    expect(run?.phases.P2_TILE_ANALYZE.tiles).toBe(1);
    expect(run?.phases.P3_MATCH.batches).toBeGreaterThan(0);
    expect(run?.phases.P4_COMPOSE.batches).toBeGreaterThan(0);
    expect(run?.memory.tilesBytes).toBe(64 * 64 * 4);
    expect(run?.config.block_size).toBe(24);
  });

  it('run はメイン画像未設定・プール空でエラーになる', async () => {
    const core = createJsCore();
    await expect(core.run()).rejects.toThrow(/main image is not set/);
    await core.setMainImage({
      width: 24,
      height: 24,
      data: new Uint8ClampedArray(24 * 24 * 4),
    });
    await expect(core.run()).rejects.toThrow(/tile pool is empty/);
  });
});
