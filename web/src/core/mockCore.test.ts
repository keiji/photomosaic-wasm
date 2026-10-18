import { describe, expect, it } from 'vitest';
import { computeGrid, createMockCore, DEFAULT_BLOCK_SIZE } from './mockCore';

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
