/**
 * ファイル検証・デコード・EXIF 反映・縮小。
 * handoff/04(M0): メイン画像 1 枚を受け付け、コアへ渡す正規形 RGBA に整える。
 * handoff/04(M3): 構成画像(タイル)を解析用・合成用サムネイルへ縮小する。
 *
 * 処理ステップの位置づけ(基本設計書 3.2):
 *   1 ファイル受付(検証) → 2 デコード(EXIF 反映) → 3 前処理(縮小)
 */
import { readImageDimensions } from './imageDimensions';

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

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'png',
  'apng',
  'webp',
  'gif',
  'bmp',
  'avif',
  'svg',
  'ico',
  'tif',
  'tiff',
  'heic',
  'heif',
  'hif',
]);

/**
 * ファイル名の拡張子から画像ファイルかを判定する(純関数)。
 *
 * 大量ドロップ時に JSON・テキストなどをデコード対象へ入れず、読み込み総数を
 * 画像枚数だけで数えるために使う。実際にデコード可能かは従来どおり
 * `validateImageFile` と `createImageBitmap` が判定する。
 */
export function isImageFileName(name: string): boolean {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot < 0 || dot === trimmed.length - 1) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(trimmed.slice(dot + 1).toLowerCase());
}

/** 画像ファイル名だけを元の順序で残す(純関数)。 */
export function filterImageFiles(files: File[]): File[] {
  return files.filter((file) => isImageFileName(file.name));
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
  /** 入力が長辺上限を超えていたため縮小したか(案内文言で使用: M7) */
  scaled?: boolean;
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
      scaled: target.scaled,
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
 * タイル用のサムネイル URL を作る。
 *
 * 元ファイルの object URL を一覧に渡すと、展開時にフル解像度画像を
 * デコードしてメモリを圧迫する。コアへ渡した長辺 64px の compose 画像から
 * 小さな Blob URL を作り、一覧表示にはこちらを使う。
 */
export async function createTileThumbnailUrl(compose: TileThumbs['compose']): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = compose.width;
  canvas.height = compose.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('failed to acquire 2D context');
  }
  ctx.putImageData(new ImageData(compose.data, compose.width, compose.height), 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/webp', 0.85);
  });
  if (blob !== null) {
    return URL.createObjectURL(blob);
  }
  // WebP エンコード非対応環境では PNG の data URL にフォールバックする
  return canvas.toDataURL('image/png');
}

/**
 * タイル画像をデコードする。ヘッダから寸法が読める形式では、長辺 64px を
 * 目標に `createImageBitmap` のリサイズオプションでデコード時点の縮小を行う。
 * Chrome 155 の計測ではこのオプション自体の速度改善は限定的だったため、
 * 速度は呼び出し側の並列デコードで稼ぎ、ここは実装差・メモリの保険とする。
 *
 * ヘッダ解析に失敗した形式・リサイズ非対応環境・寸法が極端にずれた場合は、
 * 従来どおりフル解像度デコードへフォールバックする。
 */
async function decodeTileBitmap(file: File): Promise<ImageBitmap> {
  const dimensions = await readImageDimensions(file);
  if (dimensions === null) {
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  }

  // EXIF Orientation 5〜8 は 90 度回転を含むため、幅と高さが入れ替わる
  const swapped = dimensions.orientation !== undefined && dimensions.orientation >= 5;
  const width = swapped ? dimensions.height : dimensions.width;
  const height = swapped ? dimensions.width : dimensions.height;
  if (Math.max(width, height) <= TILE_COMPOSE_THUMB_MAX) {
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  }

  const resize =
    width >= height
      ? { resizeWidth: TILE_COMPOSE_THUMB_MAX }
      : { resizeHeight: TILE_COMPOSE_THUMB_MAX };
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      ...resize,
      resizeQuality: 'high',
    });
    // 回転・アスペクト比の解釈違いで想定外に大きいビットマップが返った場合は
    // フル解像度デコードへ戻す(メモリガードの代わり)
    if (Math.max(bitmap.width, bitmap.height) <= TILE_COMPOSE_THUMB_MAX * 4) {
      return bitmap;
    }
    bitmap.close();
  } catch {
    // リサイズ付きデコード非対応環境はフル解像度デコードへフォールバック
  }
  return createImageBitmap(file, { imageOrientation: 'from-image' });
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
    bitmap = await decodeTileBitmap(file);
  } catch {
    throw new InvalidFileError('failed to decode image');
  }

  try {
    // 白背景への合成(不透明化)はサムネイル寸法で行う。
    // フルサイズの中間 canvas・getImageData を作らないこと(メモリスパイクの抑制:
    // タイルは 1 枚あたり 32×32 と長辺 64 のみを保持すればよい)。
    const compose = composeThumbSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = compose.width;
    canvas.height = compose.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('failed to acquire 2D context');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, compose.width, compose.height);
    // フル → 長辺 64 以下への縮小はホストの高品質スケーラ(drawImage)に委ね、
    // 縮小後の画素に対してボックスフィルタで特徴量用サムネイル(32×32)を作る。
    // (元画像が長辺 64 以下の場合は縮小が発生せず、元画像からの直接の
    //  ボックスフィルタ縮小と同一の結果になる)
    ctx.drawImage(bitmap, 0, 0, compose.width, compose.height);
    const flattened = ctx.getImageData(0, 0, compose.width, compose.height);

    return {
      feature: boxResize(flattened, TILE_FEATURE_THUMB, TILE_FEATURE_THUMB),
      compose: {
        width: compose.width,
        height: compose.height,
        data: new Uint8ClampedArray(flattened.data),
      },
    };
  } finally {
    bitmap.close();
  }
}
