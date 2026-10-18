import { describe, expect, it } from 'vitest';
import { MAIN_MAX_EDGE, normalizeSize } from './imageLoader';

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
