import { describe, expect, it } from 'vitest';
import { buildDownloadFilename, JPEG_QUALITY } from './exporter';

describe('buildDownloadFilename(基本設計書 3.4 のファイル名書式)', () => {
  it('既定(PNG)は photomosaic_YYYYMMDD_HHMMSS.png 形式を返す', () => {
    const name = buildDownloadFilename('png', new Date(2026, 9, 18, 7, 5, 3));
    expect(name).toBe('photomosaic_20261018_070503.png');
  });

  it('JPEG は拡張子 .jpg のファイル名を返す', () => {
    const name = buildDownloadFilename('jpeg', new Date(2026, 9, 18, 7, 5, 3));
    expect(name).toBe('photomosaic_20261018_070503.jpg');
  });

  it('月・日・時分秒は 2 桁でゼロ埋めする', () => {
    const name = buildDownloadFilename('png', new Date(2026, 0, 2, 23, 59, 9));
    expect(name).toBe('photomosaic_20260102_235909.png');
  });

  it('引数なしでは既定形式(PNG)・現在時刻を使う', () => {
    expect(buildDownloadFilename()).toMatch(/^photomosaic_\d{8}_\d{6}\.png$/);
  });
});

describe('JPEG_QUALITY(詳細設計書 5 章 jpeg_quality)', () => {
  it('既定値は 92', () => {
    expect(JPEG_QUALITY).toBe(92);
  });
});
