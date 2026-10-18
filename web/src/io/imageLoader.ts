/**
 * ファイル検証・デコード・EXIF 反映・縮小。
 * handoff/04(M0): メイン画像 1 枚を受け付け、コアへ渡す正規形 RGBA に整える。
 * handoff/04(M3): 構成画像(タイル)を解析用・合成用サムネイルへ縮小する。
 *
 * 処理ステップの位置づけ(基本設計書 3.2):
 *   1 ファイル受付(検証) → 2 デコード(EXIF 反映) → 3 前処理(縮小)
 */

/** メイン画像の長辺上限 px(詳細設計書 5 章 main_max_edge) */
export const MAIN_MAX_EDGE = 4096;

/** 特徴量算出用サムネイルの 1 辺 px(詳細設計書 5 章 feature_thumb、32×32 固定) */
export const TILE_FEATURE_THUMB = 32;

/** 合成用サムネイルの長辺上限 px(詳細設計書 5 章 compose_thumb_max) */
export const TILE_COMPOSE_THUMB_MAX = 64;

/** 許容する MIME タイプの接頭辞(ホストがデコード可能な画像形式) */
const ACCEPTED_MIME_PREFIX = 'image/';

/** 入力検証エラー(基本設計書 4 章: 非対応形式は拒否して理由を表示) */
export class InvalidFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFileError';
  }
}

/**
 * 受付可能なファイルかを検証する(純粋検査。副作用なし)。
 * 非対応形式の場合は InvalidFileError を投げる。
 */
export function validateImageFile(file: File): void {
  if (!file.type.startsWith(ACCEPTED_MIME_PREFIX)) {
    throw new InvalidFileError(`unsupported file type: ${file.type || '(empty)'}`);
  }
}

/**
 * 正規化後のサイズを計算する(純関数)。
 * 長辺が maxEdge を超える場合は等比で縮小し、超えない場合は元サイズを返す。
 * 解析・合成・出力はすべて正規化後の解像度で行う(基本設計書 3.2)。
 */
export function normalizeSize(
  width: number,
  height: number,
  maxEdge: number = MAIN_MAX_EDGE,
): { width: number; height: number; scaled: boolean } {
  if (width <= 0 || height <= 0) {
    throw new Error('image size must be positive');
  }
  const maxSide = Math.max(width, height);
  if (maxSide <= maxEdge) {
    return { width, height, scaled: false };
  }
  const scale = maxEdge / maxSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true,
  };
}

/** 正規形 RGBA 画像(コアへの入力・プレビューの入力) */
export interface LoadedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * ファイルをデコードし、EXIF 回転を反映して正規化する。
 *
 * - デコードはホスト側(Web)の責務。コアはデコードしない(基本設計書 3.2)
 * - `createImageBitmap` の `imageOrientation: 'from-image'` で EXIF 回転を反映
 * - アルファ付きメイン画像は白背景合成の上で不透明化する(詳細設計書 6 章)
 * - 長辺 4096px 超は縮小する(出力も正規化後の解像度となる)
 */
export async function loadMainImage(file: File): Promise<LoadedImage> {
  validateImageFile(file);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new InvalidFileError('failed to decode image');
  }

  try {
    const target = normalizeSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('failed to acquire 2D context');
    }

    // 白背景に先に塗ってから描画し、透明部分を白へ合成した上で不透明化する
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);

    const imageData = ctx.getImageData(0, 0, target.width, target.height);
    return {
      width: target.width,
      height: target.height,
      data: imageData.data,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * 合成用サムネイルの寸法を計算する(純関数)。
 * 長辺が maxEdge を超える場合はアスペクト維持のまま縮小し、
 * 超えない場合は元サイズを返す(詳細設計書 4.3 の 2)。
 */
export function composeThumbSize(
  width: number,
  height: number,
  maxEdge: number = TILE_COMPOSE_THUMB_MAX,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    throw new Error('image size must be positive');
  }
  const maxSide = Math.max(width, height);
  if (maxSide <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / maxSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * ボックスフィルタ(面積平均)による縮小(詳細設計書 4.3 の 2)。
 *
 * 出力 1 ピクセルごとに、対応する入力矩形領域の加重平均を取る。
 * 端数ピクセルは被覆面積を重みに加味する(単純な間引き引き伸ばしを避ける)。
 * 平均は sRGB のまま取る(特徴量の sRGB → 線形変換はコア側で行うため、
 * ここでは縮小のみを担う。ブロック平均の線形化と役割が異なる)。
 *
 * 純関数(入力を変更しない)のため node 環境の単体テストで検証できる。
 */
export function boxResize(
  source: { width: number; height: number; data: Uint8ClampedArray },
  targetWidth: number,
  targetHeight: number,
): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  if (targetWidth <= 0 || targetHeight <= 0) {
    throw new Error('target size must be positive');
  }
  if (source.width <= 0 || source.height <= 0) {
    throw new Error('source size must be positive');
  }
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const scaleX = source.width / targetWidth;
  const scaleY = source.height / targetHeight;

  for (let ty = 0; ty < targetHeight; ty++) {
    // 出力行 ty が対応する入力 Y 範囲 [sy0, sy1)
    const sy0 = ty * scaleY;
    const sy1 = (ty + 1) * scaleY;
    for (let tx = 0; tx < targetWidth; tx++) {
      // 出力列 tx が対応する入力 X 範囲 [sx0, sx1)
      const sx0 = tx * scaleX;
      const sx1 = (tx + 1) * scaleX;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let weightSum = 0;

      const yStart = Math.floor(sy0);
      const yEnd = Math.min(Math.ceil(sy1), source.height);
      const xStart = Math.floor(sx0);
      const xEnd = Math.min(Math.ceil(sx1), source.width);

      for (let sy = yStart; sy < yEnd; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        const rowOffset = sy * source.width;
        for (let sx = xStart; sx < xEnd; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const offset = (rowOffset + sx) * 4;
          sumR += (source.data[offset] as number) * weight;
          sumG += (source.data[offset + 1] as number) * weight;
          sumB += (source.data[offset + 2] as number) * weight;
          sumA += (source.data[offset + 3] as number) * weight;
          weightSum += weight;
        }
      }

      const outOffset = (ty * targetWidth + tx) * 4;
      if (weightSum > 0) {
        out[outOffset] = sumR / weightSum;
        out[outOffset + 1] = sumG / weightSum;
        out[outOffset + 2] = sumB / weightSum;
        out[outOffset + 3] = sumA / weightSum;
      } else {
        // ターゲットが極端に大きい場合(拡大)のフォールバック: 最近傍
        const srcX = Math.min(source.width - 1, Math.floor(sx0));
        const srcY = Math.min(source.height - 1, Math.floor(sy0));
        const srcOffset = (srcY * source.width + srcX) * 4;
        for (let ch = 0; ch < 4; ch++) {
          out[outOffset + ch] = source.data[srcOffset + ch] as number;
        }
      }
    }
  }

  return { width: targetWidth, height: targetHeight, data: out };
}

/** タイルのサムネイル群(コア addTile の入力。詳細設計書 4.3 の 2) */
export interface TileThumbs {
  /** 特徴量算出用サムネイル(32×32、ボックスフィルタ=面積平均) */
  feature: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };
  /** 合成用サムネイル(長辺 64 上限、アスペクト維持) */
  compose: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };
}

/**
 * 構成画像(タイル)ファイルをデコードし、解析用・合成用サムネイルへ縮小する(P2 の UI 層側)。
 *
 * - EXIF 回転を反映し、アルファ付きは白背景へ合成してから縮小する(詳細設計書 4.3 の 1)
 * - 特徴量用サムネイルは 32×32(ボックスフィルタ=面積平均)へ、
 *   合成用サムネイルは最大 64×64(アスペクト維持)へ縮小してコアへ渡す
 */
export async function loadTile(file: File): Promise<TileThumbs> {
  validateImageFile(file);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new InvalidFileError('failed to decode image');
  }

  try {
    // 白背景へ合成して不透明化した中間画像を作る(アルファ付きタイルの対策)
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('failed to acquire 2D context');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);

    const flattened = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const compose = composeThumbSize(bitmap.width, bitmap.height);
    return {
      feature: boxResize(flattened, TILE_FEATURE_THUMB, TILE_FEATURE_THUMB),
      compose: boxResize(flattened, compose.width, compose.height),
    };
  } finally {
    bitmap.close();
  }
}
