import { describe, expect, it } from 'vitest';
import {
  boxResize,
  composeThumbSize,
  MAIN_MAX_EDGE,
  normalizeSize,
  TILE_COMPOSE_THUMB_MAX,
  TILE_FEATURE_THUMB,
} from './imageLoader';

describe('normalizeSize(正規化: 詳細設計書 5 章 main_max_edge)', () => {
  it('上限以内の画像はそのまま(scaled: false)', () => {
    expect(normalizeSize(1920, 1080)).toEqual({ width: 1920, height: 1080, scaled: false });
  });

  it('長辺ちょうど 4096px は縮小しない', () => {
    expect(normalizeSize(MAIN_MAX_EDGE, 1000)).toEqual({
      width: MAIN_MAX_EDGE,
      height: 1000,
      scaled: false,
    });
  });

  it('長辺 4096px 超は等比で縮小する', () => {
    const result = normalizeSize(8000, 6000);
    expect(result.scaled).toBe(true);
    expect(result.width).toBe(4096);
    expect(result.height).toBe(Math.round(6000 * (4096 / 8000)));
    // 長辺は上限を超えない
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAIN_MAX_EDGE);
  });

  it('縦長の画像も長辺基準で縮小する', () => {
    const result = normalizeSize(3000, 6000);
    expect(result.scaled).toBe(true);
    expect(result.height).toBe(4096);
    expect(result.width).toBe(Math.round(3000 * (4096 / 6000)));
  });

  it('縮小後も 1px 未満にはならない', () => {
    const result = normalizeSize(10000, 1);
    expect(result.width).toBe(4096);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it('不正なサイズはエラーになる', () => {
    expect(() => normalizeSize(0, 10)).toThrow();
    expect(() => normalizeSize(10, -1)).toThrow();
  });
});

describe('composeThumbSize(合成用サムネイルの寸法: 詳細設計書 4.3 の 2)', () => {
  it('上限以内の画像はそのまま(アスペクト維持)', () => {
    expect(composeThumbSize(64, 32)).toEqual({ width: 64, height: 32 });
    expect(composeThumbSize(32, 32)).toEqual({ width: 32, height: 32 });
  });

  it('長辺が上限ちょうどなら縮小しない', () => {
    expect(composeThumbSize(TILE_COMPOSE_THUMB_MAX, 10)).toEqual({
      width: TILE_COMPOSE_THUMB_MAX,
      height: 10,
    });
  });

  it('長辺超過はアスペクト維持のまま縮小する', () => {
    const result = composeThumbSize(800, 400);
    expect(result.width).toBe(TILE_COMPOSE_THUMB_MAX);
    expect(result.height).toBe(32); // 400 × (64 / 800)
  });

  it('縦長の画像も長辺基準で縮小する', () => {
    const result = composeThumbSize(100, 300);
    expect(result.height).toBe(TILE_COMPOSE_THUMB_MAX);
    expect(Math.round((100 * TILE_COMPOSE_THUMB_MAX) / 300)).toBe(result.width);
  });

  it('極端な比率でも 1px 未満にはならない', () => {
    const result = composeThumbSize(10000, 1);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(TILE_COMPOSE_THUMB_MAX);
    expect(Math.min(result.width, result.height)).toBeGreaterThanOrEqual(1);
  });

  it('不正なサイズはエラーになる', () => {
    expect(() => composeThumbSize(0, 10)).toThrow();
    expect(() => composeThumbSize(10, 0)).toThrow();
  });
});

describe('boxResize(ボックスフィルタ=面積平均: 詳細設計書 4.3 の 2)', () => {
  /** 単色画像を生成する */
  const flat = (w: number, h: number, pixel: [number, number, number, number]) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let offset = 0; offset < data.length; offset += 4) {
      data[offset] = pixel[0];
      data[offset + 1] = pixel[1];
      data[offset + 2] = pixel[2];
      data[offset + 3] = pixel[3];
    }
    return { width: w, height: h, data };
  };

  it('単色画像の縮小結果は同じ単色になる', () => {
    const source = flat(100, 80, [20, 120, 220, 255]);
    const result = boxResize(source, TILE_FEATURE_THUMB, TILE_FEATURE_THUMB);
    expect(result.width).toBe(TILE_FEATURE_THUMB);
    expect(result.height).toBe(TILE_FEATURE_THUMB);
    for (let offset = 0; offset < result.data.length; offset += 4) {
      expect(result.data[offset]).toBe(20);
      expect(result.data[offset + 1]).toBe(120);
      expect(result.data[offset + 2]).toBe(220);
      expect(result.data[offset + 3]).toBe(255);
    }
  });

  it('偶数倍の縮小は領域の正確な平均になる', () => {
    // 2x2 ブロック [10, 20] / [30, 40] → 1px は平均値
    const data = new Uint8ClampedArray([
      10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255,
    ]);
    const result = boxResize({ width: 2, height: 2, data }, 1, 1);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.data[0]).toBe(25); // (10+20+30+40) / 4
  });

  it('1/3 倍のような端数縮小でも全入力が反映される', () => {
    // 3x1 [0, 150, 255] → 1px: 面積平均 (0+150+255)/3 = 135
    const data = new Uint8ClampedArray([0, 0, 0, 255, 150, 150, 150, 255, 255, 255, 255, 255]);
    const result = boxResize({ width: 3, height: 1, data }, 1, 1);
    expect(result.data[0]).toBe(135);
  });

  it('入力バッファは変更されない(純関数)', () => {
    const source = flat(8, 8, [10, 20, 30, 255]);
    const before = Array.from(source.data);
    boxResize(source, 4, 4);
    expect(Array.from(source.data)).toEqual(before);
  });

  it('不正なターゲットサイズはエラーになる', () => {
    const source = flat(8, 8, [0, 0, 0, 255]);
    expect(() => boxResize(source, 0, 4)).toThrow();
    expect(() => boxResize(source, 4, 0)).toThrow();
  });

  it('不正なソースサイズはエラーになる', () => {
    expect(() =>
      boxResize({ width: 0, height: 8, data: new Uint8ClampedArray(0) }, 4, 4),
    ).toThrow();
  });

  it('300 枚分の縮小が 1 枚あたり数 ms 未満で完了する(M3 完了条件のリグレッション検知)', () => {
    // 完了条件(handoff/04 M3): 1 枚あたり数 ms。
    // 64x64 → 32x32 の縮小を 300 回実行し、環境差を考慮した緩い上限で検知する。
    const source = flat(64, 64, [100, 150, 200, 255]);
    const start = performance.now();
    for (let i = 0; i < 300; i++) {
      boxResize(source, TILE_FEATURE_THUMB, TILE_FEATURE_THUMB);
    }
    const perTileMs = (performance.now() - start) / 300;
    expect(perTileMs).toBeLessThan(5);
  });
});
