/**
 * 色空間変換の TypeScript 実装(sRGB ↔ 線形 RGB ↔ CIELAB(D65))。
 *
 * Rust コア(core/src/color.rs)の移植。決定性のため内部計算は number(f64)で
 * 行い、f32 フィールドへ格納する箇所のみ Math.fround で丸める。
 */

/** f32 への丸め(Rust の `as f32` に対応) */
export function f32(value: number): number {
  return Math.fround(value);
}

/** sRGB の 8bit 値を線形 RGB(0.0..1.0)へ変換する */
export function srgb8ToLinear(value: number): number {
  const c = value / 255.0;
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB 逆曲線の前計算表の分割数 */
const SRGB_CURVE_SAMPLES = 4096;

let srgbCurveTable: Float64Array | null = null;

function srgbCurveSample(value: number): number {
  if (srgbCurveTable === null) {
    const table = new Float64Array(SRGB_CURVE_SAMPLES);
    const xBegin = 0.0031308;
    const span = 1.0 - xBegin;
    for (let i = 0; i < SRGB_CURVE_SAMPLES; i++) {
      const x = xBegin + (span * i) / (SRGB_CURVE_SAMPLES - 1);
      table[i] = 1.055 * Math.pow(x, 1.0 / 2.4) - 0.055;
    }
    srgbCurveTable = table;
  }
  const xBegin = 0.0031308;
  const span = 1.0 - xBegin;
  const position = ((value - xBegin) / span) * (SRGB_CURVE_SAMPLES - 1);
  const index = Math.min(Math.floor(position), SRGB_CURVE_SAMPLES - 2);
  const frac = position - index;
  const lower = srgbCurveTable[index] as number;
  const upper = srgbCurveTable[index + 1] as number;
  return lower + (upper - lower) * frac;
}

/** 線形 RGB(0.0..1.0)を sRGB の 8bit 値へ変換する(丸め、クランプ付き) */
export function linearToSrgb8(value: number): number {
  const clamped = Math.min(Math.max(value, 0.0), 1.0);
  let c: number;
  if (clamped <= 0.0031308) {
    c = clamped * 12.92;
  } else if (clamped >= 1.0) {
    c = 1.0;
  } else {
    c = srgbCurveSample(clamped);
  }
  return Math.min(255, Math.max(0, Math.round(c * 255.0)));
}

/** 線形 RGB → CIEXYZ(sRGB の D65 プライマリに対する標準変換行列) */
export function linearRgbToXyz(r: number, g: number, b: number): [number, number, number] {
  return [
    0.4123907992659595 * r + 0.35758433938387796 * g + 0.1804807884018343 * b,
    0.21263900587151036 * r + 0.7151686787677559 * g + 0.07219231536073371 * b,
    0.01933081871559185 * r + 0.11919477979462599 * g + 0.9505321522496606 * b,
  ];
}

/** CIEXYZ → 線形 RGB(上記の逆行列) */
export function xyzToLinearRgb(x: number, y: number, z: number): [number, number, number] {
  return [
    3.2409699419045213 * x - 1.5373831775700935 * y - 0.4986107602930033 * z,
    -0.9692436362808798 * x + 1.8759675015077206 * y + 0.04155505740717561 * z,
    0.05563007969699361 * x - 0.20397695888897657 * y + 1.0569715142428786 * z,
  ];
}

/** sRGB 標準の D65 白色点(変換行列の行和から厳密に求める) */
const D65_X = 0.4123907992659595 + 0.35758433938387796 + 0.1804807884018343;
const D65_Y = 0.21263900587151036 + 0.7151686787677559 + 0.07219231536073371;
const D65_Z = 0.01933081871559185 + 0.11919477979462599 + 0.9505321522496606;

const LAB_DELTA = 6.0 / 29.0;
const LAB_DELTA3 = LAB_DELTA * LAB_DELTA * LAB_DELTA;

function labF(t: number): number {
  if (t > LAB_DELTA3) {
    return Math.cbrt(t);
  }
  return t / (3.0 * LAB_DELTA * LAB_DELTA) + 4.0 / 29.0;
}

function labFInv(t: number): number {
  const t3 = t * t * t;
  if (t3 > LAB_DELTA3) {
    return t3;
  }
  return 3.0 * LAB_DELTA * LAB_DELTA * (t - 4.0 / 29.0);
}

/** CIEXYZ → CIELAB(D65) */
export function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const fx = labF(x / D65_X);
  const fy = labF(y / D65_Y);
  const fz = labF(z / D65_Z);
  return [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)];
}

/** CIELAB(D65) → CIEXYZ */
export function labToXyz(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16.0) / 116.0;
  const fx = fy + a / 500.0;
  const fz = fy - b / 200.0;
  return [D65_X * labFInv(fx), D65_Y * labFInv(fy), D65_Z * labFInv(fz)];
}

/** sRGB 8bit → CIELAB */
export function srgb8ToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgb8ToLinear(r);
  const lg = srgb8ToLinear(g);
  const lb = srgb8ToLinear(b);
  const [x, y, z] = linearRgbToXyz(lr, lg, lb);
  return xyzToLab(x, y, z);
}

/** CIELAB → sRGB 8bit(プレビュー描画などホスト表示用の逆変換) */
export function labToSrgb8(l: number, a: number, b: number): [number, number, number] {
  const [x, y, z] = labToXyz(l, a, b);
  const [r, g, blue] = xyzToLinearRgb(x, y, z);
  return [linearToSrgb8(r), linearToSrgb8(g), linearToSrgb8(blue)];
}

/** 線形 RGB → CIE L*(明度のみ。detail 計算用の軽量経路) */
export function linearRgbToLstar(r: number, g: number, b: number): number {
  const y = 0.21263900587151036 * r + 0.7151686787677559 * g + 0.07219231536073371 * b;
  return lstarFromYOverYn(y);
}

const LSTAR_SHAPE_SAMPLES = 4096;
let lstarShapeTable: Float64Array | null = null;

function lstarFromYOverYn(yOverYn: number): number {
  const c3 = LAB_DELTA3;
  if (yOverYn <= c3) {
    const f = (1.0 / 3.0) * (29.0 / 6.0) * (29.0 / 6.0) * yOverYn + 4.0 / 29.0;
    return 116.0 * f - 16.0;
  }
  if (lstarShapeTable === null) {
    const table = new Float64Array(LSTAR_SHAPE_SAMPLES);
    const tBegin = c3;
    const span = 1.0 - tBegin;
    for (let i = 0; i < LSTAR_SHAPE_SAMPLES; i++) {
      const x = tBegin + (span * i) / (LSTAR_SHAPE_SAMPLES - 1);
      table[i] = Math.cbrt(x);
    }
    lstarShapeTable = table;
  }
  const t = Math.min(yOverYn, 1.0);
  const tBegin = c3;
  const span = 1.0 - tBegin;
  const position = ((t - tBegin) / span) * (LSTAR_SHAPE_SAMPLES - 1);
  const index = Math.min(Math.floor(position), LSTAR_SHAPE_SAMPLES - 2);
  const frac = position - index;
  const lower = lstarShapeTable[index] as number;
  const upper = lstarShapeTable[index + 1] as number;
  const f = lower + (upper - lower) * frac;
  return 116.0 * f - 16.0;
}

let srgbLinearLut: Float64Array | null = null;

/** ΔE76: CIELAB 間のユークリッド距離(f32 精度) */
export function deltaE76(a: readonly number[], b: readonly number[]): number {
  const dl = (a[0] as number) - (b[0] as number);
  const da = (a[1] as number) - (b[1] as number);
  const db = (a[2] as number) - (b[2] as number);
  return f32(Math.sqrt(dl * dl + da * da + db * db));
}

/** sRGB → 線形 RGB の 256 値ルックアップテーブル */
export function srgb8LinearLut(): Float64Array {
  if (srgbLinearLut === null) {
    const table = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
      table[i] = srgb8ToLinear(i);
    }
    srgbLinearLut = table;
  }
  return srgbLinearLut;
}
