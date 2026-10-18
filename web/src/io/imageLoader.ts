/**
 * ファイル検証・デコード・EXIF 反映・縮小。
 * handoff/04(M0): メイン画像 1 枚を受け付け、コアへ渡す正規形 RGBA に整える。
 *
 * 処理ステップの位置づけ(基本設計書 3.2):
 *   1 ファイル受付(検証) → 2 デコード(EXIF 反映) → 3 前処理(長辺 4096px へ縮小)
 */

/** メイン画像の長辺上限 px(詳細設計書 5 章 main_max_edge) */
export const MAIN_MAX_EDGE = 4096;

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
