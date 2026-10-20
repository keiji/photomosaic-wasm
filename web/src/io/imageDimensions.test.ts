import { describe, expect, it } from 'vitest';
import { parseImageDimensions } from './imageDimensions';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function sofSegment(width: number, height: number): number[] {
  return [
    0xff,
    0xc0,
    0x00,
    0x11, // length 17
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ];
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...sofSegment(width, height)]);
}

function jpegWithExif(width: number, height: number, orientation: number): Uint8Array {
  const exif = new Uint8Array(32);
  exif.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // "Exif\0\0"
  exif.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 6); // II, 42, IFD0 offset 8
  exif.set([0x01, 0x00], 14); // IFD0 entry count
  exif.set([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00], 16); // Orientation, SHORT, count 1
  exif.set([orientation, 0x00, 0x00, 0x00], 24);
  exif.set([0x00, 0x00, 0x00, 0x00], 28); // next IFD

  const app1Length = exif.length + 2;
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    (app1Length >> 8) & 0xff,
    app1Length & 0xff,
    ...exif,
    ...sofSegment(width, height),
  ]);
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set([0x42, 0x4d], 0); // "BM"
  const view = new DataView(bytes.buffer);
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true); // top-down bitmap
  return bytes;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  bytes.set([0x0a, 0x00, 0x00, 0x00], 16); // chunk size 10
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

describe('parseImageDimensions(デコード時縮小のためのヘッダ解析)', () => {
  it('PNG の IHDR から寸法を読む', () => {
    expect(parseImageDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('JPEG の SOF0 から寸法を読む', () => {
    expect(parseImageDimensions(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('JPEG の EXIF Orientation を読む', () => {
    expect(parseImageDimensions(jpegWithExif(640, 480, 6))).toEqual({
      width: 640,
      height: 480,
      orientation: 6,
    });
  });

  it('GIF の論理画面サイズを読む', () => {
    expect(parseImageDimensions(gif(320, 240))).toEqual({ width: 320, height: 240 });
  });

  it('BMP の負の高さ(トップダウン)を絶対値で扱う', () => {
    expect(parseImageDimensions(bmp(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('WebP の VP8X キャンバスサイズを読む', () => {
    expect(parseImageDimensions(webpVp8x(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('未対応・壊れたヘッダは null を返す', () => {
    expect(parseImageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseImageDimensions(new Uint8Array(0))).toBeNull();
  });
});
