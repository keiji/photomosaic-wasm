/**
 * エンコード・ダウンロード(P5 EXPORT のホスト側処理)。
 * 基本設計書 3.4: コアから RGBA を受け取り canvas で PNG(既定)または JPEG を
 * 生成し、`<a download>` 経由でダウンロードを開始する(M8 で保存形式選択を追加)。
 * 出力はピクセルからの再エンコードで、入力画像のメタデータ(EXIF 等)は継承しない。
 */

/** 保存形式(詳細設計書 4.7: 既定形式 PNG。JPEG 選択時の品質は 92) */
export type ExportFormat = 'png' | 'jpeg';

const MIME_TYPES: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
};

/** ファイル名の拡張子(JPEG は慣例に従い .jpg) */
const EXTENSIONS: Record<ExportFormat, string> = {
  png: '.png',
  jpeg: '.jpg',
};

/** JPEG 選択時の品質(詳細設計書 5 章 jpeg_quality: 92 / 範囲 60〜100) */
export const JPEG_QUALITY = 92;

/**
 * ダウンロード用ファイル名を生成する(純関数)。
 * 書式: photomosaic_YYYYMMDD_HHMMSS + 拡張子(基本設計書 3.4。既定は .png)
 */
export function buildDownloadFilename(
  format: ExportFormat = 'png',
  now: Date = new Date(),
): string {
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const h = pad2(now.getHours());
  const mi = pad2(now.getMinutes());
  const s = pad2(now.getSeconds());
  return `photomosaic_${y}${mo}${d}_${h}${mi}${s}${EXTENSIONS[format]}`;
}

/** RGBA 画像を指定形式へエンコードする(ピクセルからの再エンコードでメタデータは継承しない) */
export async function encodeImage(
  image: {
    width: number;
    height: number;
    data: Uint8ClampedArray<ArrayBuffer>;
  },
  format: ExportFormat = 'png',
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('failed to acquire 2D context');
  }
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  const quality = format === 'jpeg' ? JPEG_QUALITY / 100 : undefined;
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error(`failed to encode ${format.toUpperCase()}`));
        }
      },
      MIME_TYPES[format],
      quality,
    );
  });
}

/** Blob をブラウザ経由でダウンロードする */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
