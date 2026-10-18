/**
 * エンコード・ダウンロード(P5 EXPORT のホスト側処理)。
 * 基本設計書 3.4: コアから RGBA を受け取り canvas で PNG を生成し、
 * `<a download>` 経由でダウンロードを開始する。
 */

/** 既定の保存形式(詳細設計書 4.7) */
const EXPORT_MIME_TYPE = 'image/png';

/**
 * ダウンロード用ファイル名を生成する(純関数)。
 * 書式: photomosaic_YYYYMMDD_HHMMSS.png(基本設計書 3.4)
 */
export function buildDownloadFilename(now: Date = new Date()): string {
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const h = pad2(now.getHours());
  const mi = pad2(now.getMinutes());
  const s = pad2(now.getSeconds());
  return `photomosaic_${y}${mo}${d}_${h}${mi}${s}.png`;
}

/** RGBA 画像を PNG へエンコードする(ピクセルからの再エンコードでメタデータは継承しない) */
export async function encodePng(image: {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('failed to acquire 2D context');
  }
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('failed to encode PNG'));
      }
    }, EXPORT_MIME_TYPE);
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
