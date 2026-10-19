/**
 * 合成(P4)の TypeScript 実装(詳細設計書 4.6)。
 *
 * Rust コア(core/src/compose.rs)の移植。タイルの合成用サムネイルを
 * ブロック矩形へバイリニアでスケーリングし、線形 RGB 空間で色補正する。
 * メイン画像ブレンドは sRGB 空間の線形補間で行う。
 */
import type { GridInfo, MosaicConfig } from '../types';
import { labToXyz, linearToSrgb8, srgb8LinearLut, xyzToLinearRgb } from './color';
import type { BlockFeature } from './grid';
import type { TileFeature, TilePool } from './tilePool';

type RgbaBytes = Uint8Array | Uint8ClampedArray;

/** 行範囲 `[rowBegin, rowEnd)` を合成済みバッファへ描画する(P4) */
export function composeRows(
  out: RgbaBytes,
  grid: GridInfo,
  features: readonly BlockFeature[],
  assignments: ReadonlyArray<bigint | null>,
  pool: TilePool,
  config: MosaicConfig,
  mainRgba: RgbaBytes | undefined,
  rowBegin: number,
  rowEnd: number,
): void {
  const width = grid.width;
  const height = grid.height;
  if (out.length !== width * height * 4) {
    throw new Error('output buffer length mismatch');
  }
  if (features.length !== grid.totalBlocks) {
    throw new Error('block feature count mismatch');
  }
  if (assignments.length !== features.length) {
    throw new Error('assignment count mismatch');
  }
  if (mainRgba && mainRgba.length !== width * height * 4) {
    throw new Error('main image length mismatch');
  }
  const end = Math.min(rowEnd, grid.rows);

  for (let row = rowBegin; row < end; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const blockIndex = row * grid.cols + col;
      const tileId = assignments[blockIndex];
      if (tileId === null || tileId === undefined) {
        continue;
      }
      const tile = pool.feature(tileId);
      if (!tile) {
        continue;
      }
      drawBlockCell(out, grid, features[blockIndex] as BlockFeature, tile, pool, config, mainRgba);
    }
  }
}

/** 全体を一括合成する */
export function compose(
  grid: GridInfo,
  features: readonly BlockFeature[],
  assignments: ReadonlyArray<bigint | null>,
  pool: TilePool,
  config: MosaicConfig,
  mainRgba?: RgbaBytes,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(grid.width * grid.height * 4);
  composeRows(out, grid, features, assignments, pool, config, mainRgba, 0, grid.rows);
  return out;
}

function drawBlockCell(
  out: RgbaBytes,
  grid: GridInfo,
  feature: BlockFeature,
  tile: TileFeature,
  pool: TilePool,
  config: MosaicConfig,
  mainRgba: RgbaBytes | undefined,
): void {
  const width = grid.width;
  const blockSize = grid.blockSize;
  const col = feature.index % grid.cols;
  const row = Math.floor(feature.index / grid.cols);
  const x0 = col * blockSize;
  const y0 = row * blockSize;
  const bw = Math.min(blockSize, width - x0);
  const bh = Math.min(blockSize, grid.height - y0);

  const thumb = pool.composeThumb(tile.id);
  if (!thumb || thumb.width === 0 || thumb.height === 0 || bw === 0 || bh === 0) {
    return;
  }

  const blockLinear = labMeanToLinear(feature.meanLab);
  const tileLinear = labMeanToLinear(tile.meanLab);
  const alpha = config.color_correct;
  const factors: [number, number, number] = [1.0, 1.0, 1.0];
  for (let c = 0; c < 3; c++) {
    const tileValue = tileLinear[c] as number;
    if (tileValue >= 1.0 / 255.0) {
      factors[c] = 1.0 - alpha + alpha * ((blockLinear[c] as number) / tileValue);
    }
  }

  const blend = config.main_blend;
  const mainPixels = blend > 0.0 ? mainRgba : undefined;
  const lut = srgb8LinearLut();
  const thumbStride = thumb.width * 4;

  const stepX = thumb.width / bw;
  const stepY = thumb.height / bh;
  const originX = 0.5 * stepX - 0.5;
  const originY = 0.5 * stepY - 0.5;

  for (let y = 0; y < bh; y++) {
    const srcY = y * stepY + originY;
    const py0 = Math.floor(srcY);
    const fy = srcY - py0;
    const cy0 = Math.min(thumb.height - 1, Math.max(0, py0));
    const cy1 = Math.min(thumb.height - 1, Math.max(0, py0 + 1));
    const row0 = cy0 * thumbStride;
    const row1 = cy1 * thumbStride;
    const wy0 = 1.0 - fy;
    const wy1 = fy;

    for (let x = 0; x < bw; x++) {
      const srcX = x * stepX + originX;
      const px0 = Math.floor(srcX);
      const fx = srcX - px0;
      const cx0 = Math.min(thumb.width - 1, Math.max(0, px0));
      const cx1 = Math.min(thumb.width - 1, Math.max(0, px0 + 1));

      const idx00 = row0 + cx0 * 4;
      const idx10 = row0 + cx1 * 4;
      const idx01 = row1 + cx0 * 4;
      const idx11 = row1 + cx1 * 4;
      const wx0 = 1.0 - fx;
      const wx1 = fx;
      const w00 = wx0 * wy0;
      const w10 = wx1 * wy0;
      const w01 = wx0 * wy1;
      const w11 = wx1 * wy1;

      const offsetOut = ((y0 + y) * width + x0 + x) * 4;
      const data = thumb.data;
      for (let c = 0; c < 3; c++) {
        const linear =
          w00 * (lut[data[idx00 + c] as number] as number) +
          w10 * (lut[data[idx10 + c] as number] as number) +
          w01 * (lut[data[idx01 + c] as number] as number) +
          w11 * (lut[data[idx11 + c] as number] as number);
        let value = linearToSrgb8(linear * (factors[c] as number));
        if (mainPixels) {
          const mixed = (1.0 - blend) * value + blend * (mainPixels[offsetOut + c] as number);
          value = Math.round(mixed);
        }
        out[offsetOut + c] = value;
      }
      out[offsetOut + 3] = 255;
    }
  }
}

/** CIELAB 平均 → 線形 RGB 平均(P4 色補正用) */
function labMeanToLinear(lab: readonly number[]): [number, number, number] {
  const [x, y, z] = labToXyz(lab[0] as number, lab[1] as number, lab[2] as number);
  return xyzToLinearRgb(x, y, z);
}
