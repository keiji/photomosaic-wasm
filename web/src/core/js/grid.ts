/**
 * ブロック分割・ブロック特徴量の TypeScript 実装(P1)。
 *
 * Rust コア(core/src/grid.rs)の移植。グリッドは
 * cols = ceil(w / block_size), rows = ceil(h / block_size) で計算し、
 * 右端・下端は半端サイズのブロックになる。
 */
import type { GridInfo } from '../types';
import { f32, linearRgbToLstar, linearRgbToXyz, srgb8LinearLut, xyzToLab } from './color';

/** ブロックサイズの既定値(詳細設計書 5 章 block_size) */
export const DEFAULT_BLOCK_SIZE = 24;

/** ブロック特徴量(詳細設計書 3 章 BlockFeature) */
export interface BlockFeature {
  /** ブロック番号 = row * cols + col */
  index: number;
  /** CIELAB 平均 (L*, a*, b*)。f32 精度で保持する */
  meanLab: [number, number, number];
  /** ブロック内 L* の標準偏差(0..128) */
  detail: number;
  /** 有効画素数(半端ブロックは block_size² 未満) */
  weight: number;
}

/** グリッド計算(詳細設計書 4.2 の 1) */
export function computeGridInfo(width: number, height: number, blockSize: number): GridInfo {
  if (width <= 0 || height <= 0) {
    throw new Error('image size must be positive');
  }
  if (blockSize <= 0) {
    throw new Error('block size must be positive');
  }
  const cols = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);
  return {
    width,
    height,
    blockSize,
    cols,
    rows,
    totalBlocks: cols * rows,
  };
}

/** メイン画像全体のブロック特徴量を計算する(P1) */
export function computeBlockFeatures(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  blockSize: number,
): BlockFeature[] {
  const grid = computeGridInfo(width, height, blockSize);
  if (rgba.length !== width * height * 4) {
    throw new Error('rgba buffer length mismatch');
  }

  const lut = srgb8LinearLut();
  const features: BlockFeature[] = new Array(grid.totalBlocks);

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const x0 = col * blockSize;
      const y0 = row * blockSize;
      const bw = Math.min(blockSize, width - x0);
      const bh = Math.min(blockSize, height - y0);
      const count = bw * bh;

      let sumR = 0.0;
      let sumG = 0.0;
      let sumB = 0.0;
      let sumLstar = 0.0;
      let sumLstarSq = 0.0;

      for (let y = y0; y < y0 + bh; y++) {
        const rowOffset = y * width * 4;
        for (let x = x0; x < x0 + bw; x++) {
          const offset = rowOffset + x * 4;
          const lr = lut[rgba[offset] as number] as number;
          const lg = lut[rgba[offset + 1] as number] as number;
          const lb = lut[rgba[offset + 2] as number] as number;

          sumR += lr;
          sumG += lg;
          sumB += lb;

          const lstar = linearRgbToLstar(lr, lg, lb);
          sumLstar += lstar;
          sumLstarSq += lstar * lstar;
        }
      }

      const n = count;
      const meanLinear: [number, number, number] = [sumR / n, sumG / n, sumB / n];
      const [x, y, z] = linearRgbToXyz(meanLinear[0], meanLinear[1], meanLinear[2]);
      const meanLab = xyzToLab(x, y, z);

      const meanL = sumLstar / n;
      const variance = Math.max(0.0, sumLstarSq / n - meanL * meanL);

      features[row * grid.cols + col] = {
        index: row * grid.cols + col,
        meanLab: [f32(meanLab[0]), f32(meanLab[1]), f32(meanLab[2])],
        detail: f32(Math.sqrt(variance)),
        weight: f32(n),
      };
    }
  }

  return features;
}
