import { describe, expect, it } from 'vitest';
import { buildDownloadFilename } from './exporter';

describe('buildDownloadFilename(基本設計書 3.4 のファイル名書式)', () => {
  it('photomosaic_YYYYMMDD_HHMMSS.png 形式を返す', () => {
    const name = buildDownloadFilename(new Date(2026, 9, 18, 7, 5, 3));
    expect(name).toBe('photomosaic_20261018_070503.png');
  });

  it('月・日・時分秒は 2 桁でゼロ埋めする', () => {
    const name = buildDownloadFilename(new Date(2026, 0, 2, 23, 59, 9));
    expect(name).toBe('photomosaic_20260102_235909.png');
  });
});
