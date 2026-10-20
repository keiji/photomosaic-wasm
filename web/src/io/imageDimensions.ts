/**
 * 画像ヘッダから寸法を読むユーティリティ。
 *
 * タイル読み込み時にフル解像度デコードを避け、`createImageBitmap` の
 * `resizeWidth` / `resizeHeight` でデコード時点の縮小を行うために使う。
 * ヘッダだけで判定できない形式は `null` を返し、呼び出し側が従来どおり
 * フル解像度デコードへフォールバックする。
 */

export interface ImageDimensions {
  width: number;
  height: number;
  /** EXIF Orientation(1〜8)。JPEG の APP1 に存在する場合のみ設定する。 */
  orientation?: number;
}

/** 先頭から読む最大バイト数。JPEG の EXIF は通常この範囲に収まる。 */
const HEADER_BYTES = 128 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8] as const;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] as const;

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || offset + expected.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string | null {
  if (offset < 0 || offset + length > bytes.length) {
    return null;
  }
  let text = '';
  for (let i = 0; i < length; i++) {
    const value = bytes[offset + i];
    if (value === undefined) {
      return null;
    }
    text += String.fromCharCode(value);
  }
  return text;
}

function readU16(view: DataView, offset: number, littleEndian: boolean): number | null {
  if (offset < 0 || offset + 2 > view.byteLength) {
    return null;
  }
  return view.getUint16(offset, littleEndian);
}

function readU32(view: DataView, offset: number, littleEndian: boolean): number | null {
  if (offset < 0 || offset + 4 > view.byteLength) {
    return null;
  }
  return view.getUint32(offset, littleEndian);
}

function readI32(view: DataView, offset: number, littleEndian: boolean): number | null {
  if (offset < 0 || offset + 4 > view.byteLength) {
    return null;
  }
  return view.getInt32(offset, littleEndian);
}

function readU24le(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 3 > bytes.length) {
    return null;
  }
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 === undefined || b1 === undefined || b2 === undefined) {
    return null;
  }
  return b0 | (b1 << 8) | (b2 << 16);
}

function validDimensions(width: number | null, height: number | null): ImageDimensions | null {
  if (width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function parsePng(bytes: Uint8Array): ImageDimensions | null {
  if (!matches(bytes, 0, PNG_SIGNATURE)) {
    return null;
  }
  const view = dataView(bytes);
  return validDimensions(readU32(view, 16, false), readU32(view, 20, false));
}

function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * TIFF/EXIF の IFD0 から Orientation(0x0112)を読む。
 * 値は 1〜8 のいずれか。見つからない・壊れている場合は null。
 */
function parseExifOrientation(bytes: Uint8Array, tiffOffset: number): number | null {
  const view = dataView(bytes);
  const byteOrder = ascii(bytes, tiffOffset, 2);
  if (byteOrder !== 'II' && byteOrder !== 'MM') {
    return null;
  }
  const littleEndian = byteOrder === 'II';
  if (readU16(view, tiffOffset + 2, littleEndian) !== 42) {
    return null;
  }
  const ifdOffset = readU32(view, tiffOffset + 4, littleEndian);
  if (ifdOffset === null) {
    return null;
  }
  const ifd = tiffOffset + ifdOffset;
  const entryCount = readU16(view, ifd, littleEndian);
  if (entryCount === null || entryCount > 512) {
    return null;
  }
  for (let i = 0; i < entryCount; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) {
      return null;
    }
    const tag = readU16(view, entry, littleEndian);
    if (tag === 0x0112) {
      const type = readU16(view, entry + 2, littleEndian);
      const valueCount = readU32(view, entry + 4, littleEndian);
      if (type !== 3 || valueCount !== 1) {
        return null;
      }
      const value = readU16(view, entry + 8, littleEndian);
      if (value === null || value < 1 || value > 8) {
        return null;
      }
      return value;
    }
  }
  return null;
}

function parseJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (!matches(bytes, 0, JPEG_SIGNATURE)) {
    return null;
  }
  const view = dataView(bytes);
  let offset = 2;
  let orientation: number | undefined;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let marker = bytes[offset + 1];
    // 0xFF のフィルバイトを読み飛ばす
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    if (marker === undefined) {
      return null;
    }

    // 長さを持たないマーカー
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }

    const length = readU16(view, offset + 2, false);
    if (length === null || length < 2) {
      return null;
    }
    const segmentEnd = offset + 2 + length;
    if (segmentEnd > bytes.length) {
      return null;
    }

    if (marker === 0xe1 && length >= 16 && matches(bytes, offset + 4, EXIF_HEADER)) {
      const parsed = parseExifOrientation(bytes, offset + 10);
      if (parsed !== null) {
        orientation = parsed;
      }
    }

    if (isSofMarker(marker)) {
      if (length < 7) {
        return null;
      }
      const height = readU16(view, offset + 5, false);
      const width = readU16(view, offset + 7, false);
      const dimensions = validDimensions(width, height);
      if (dimensions === null) {
        return null;
      }
      if (orientation !== undefined) {
        dimensions.orientation = orientation;
      }
      return dimensions;
    }

    offset = segmentEnd;
  }
  return null;
}

function parseGif(bytes: Uint8Array): ImageDimensions | null {
  const signature = ascii(bytes, 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    return null;
  }
  const view = dataView(bytes);
  return validDimensions(readU16(view, 6, true), readU16(view, 8, true));
}

function parseBmp(bytes: Uint8Array): ImageDimensions | null {
  if (!matches(bytes, 0, [0x42, 0x4d])) {
    return null;
  }
  const view = dataView(bytes);
  const width = readI32(view, 18, true);
  const height = readI32(view, 22, true);
  if (width === null || height === null) {
    return null;
  }
  return validDimensions(width, Math.abs(height));
}

function parseWebp(bytes: Uint8Array): ImageDimensions | null {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return null;
  }
  const chunk = ascii(bytes, 12, 4);
  const view = dataView(bytes);

  if (chunk === 'VP8X') {
    const width = readU24le(bytes, 24);
    const height = readU24le(bytes, 27);
    if (width === null || height === null) {
      return null;
    }
    return validDimensions(width + 1, height + 1);
  }

  if (chunk === 'VP8 ') {
    if (!matches(bytes, 23, [0x9d, 0x01, 0x2a])) {
      return null;
    }
    const width = readU16(view, 26, true);
    const height = readU16(view, 28, true);
    if (width === null || height === null) {
      return null;
    }
    return validDimensions(width & 0x3fff, height & 0x3fff);
  }

  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) {
      return null;
    }
    const bits = readU32(view, 21, true);
    if (bits === null) {
      return null;
    }
    return validDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }

  return null;
}

/** 画像ヘッダのバイト列から寸法を読む(純関数)。未対応形式は null。 */
export function parseImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return (
    parsePng(bytes) ?? parseJpeg(bytes) ?? parseGif(bytes) ?? parseBmp(bytes) ?? parseWebp(bytes)
  );
}

/** ファイル先頭のヘッダだけを読み、寸法を返す。読み取り失敗時は null。 */
export async function readImageDimensions(file: File): Promise<ImageDimensions | null> {
  try {
    const header = await file.slice(0, HEADER_BYTES).arrayBuffer();
    return parseImageDimensions(new Uint8Array(header));
  } catch {
    return null;
  }
}
