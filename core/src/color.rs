//! 色空間変換:sRGB ↔ 線形 RGB ↔ CIELAB(D65)。
//!
//! 詳細設計書 4.2/4.3:
//! - 平均は sRGB のまま取らず、**線形 RGB で平均化**する(自然な混色のため)
//! - 距離計算・平均計算の色空間は CIELAB(D65)に固定
//!
//! 決定性のため、内部計算は f64 に統一する(f32 との混在禁止。handoff/02 4 章の
//! 決定性指針)。BlockFeature への格納時のみ f32 へ丸める(変換は決定的)。

/// sRGB の 8bit 値を線形 RGB(0.0..1.0)へ変換する
pub fn srgb8_to_linear(value: u8) -> f64 {
    let c = f64::from(value) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// 線形 → sRGB 曲線部 ( LINEAR_BREAK, 1.0 ] の等間隔前計算区分
const SRGB_CURVE_SAMPLES: usize = 4096;

/// 線形 RGB(0.0..1.0)を sRGB の 8bit 値へ変換する(丸め、クランプ付き)。
///
/// 曲線部((0.0031308, 1.0])は等間隔 4,096 分割の前計算表 + 線形補間で求める
// (P4 合成では全出力ピクセル × 3 チャンネルで powf が走り、12MP で数千 ms 相当
// になるため: handoff/05 §7 の P4 目標)。線形補間の最大誤差は 0.5/255 未満の
// 目安で、8bit に丸めた結果は厳密式(powf)と同一の値が得られる。
/// 計算は f64 で統一し決定的(handoff/02 4 章)
pub fn linear_to_srgb8(value: f64) -> u8 {
    let clamped = value.clamp(0.0, 1.0);
    let c = if clamped <= 0.003_130_8 {
        clamped * 12.92
    } else if clamped >= 1.0 {
        1.0
    } else {
        srgb8_curve_sample(clamped)
    };
    (c * 255.0).round() as u8
}

/// sRGB 逆曲線(線形 → sRGB の (0.0031308, 1.0] 区間)の前計算表。
/// `entry[i] = 1.055 × x_i^(1/2.4) - 0.055`(`x_i = 0.0031308 + i·Δx`)
fn srgb8_curve_sample(value: f64) -> f64 {
    static LUT: std::sync::OnceLock<Box<[f64; SRGB_CURVE_SAMPLES]>> = std::sync::OnceLock::new();
    let table = LUT.get_or_init(|| {
        let mut table: Box<[f64; SRGB_CURVE_SAMPLES]> = Box::new([0.0; SRGB_CURVE_SAMPLES]);
        let x_begin = 0.003_130_8_f64;
        let span = 1.0 - x_begin;
        for (i, slot) in table.iter_mut().enumerate() {
            let x = x_begin + span * (i as f64) / ((SRGB_CURVE_SAMPLES - 1) as f64);
            *slot = 1.055 * x.powf(1.0 / 2.4) - 0.055;
        }
        table
    });
    let x_begin = 0.003_130_8_f64;
    let span = 1.0 - x_begin;
    let position = (value - x_begin) / span * ((SRGB_CURVE_SAMPLES - 1) as f64);
    let index = (position as usize).min(SRGB_CURVE_SAMPLES - 2);
    let frac = position - index as f64;
    let lower = table[index];
    let upper = table[index + 1];
    lower + (upper - lower) * frac
}

/// 線形 RGB → CIEXYZ(sRGB の D65 プライマリに対する標準変換行列)
pub fn linear_rgb_to_xyz(r: f64, g: f64, b: f64) -> [f64; 3] {
    [
        0.412_390_799_265_959_5 * r + 0.357_584_339_383_877_96 * g + 0.180_480_788_401_834_3 * b,
        0.212_639_005_871_510_36 * r + 0.715_168_678_767_755_9 * g + 0.072_192_315_360_733_71 * b,
        0.019_330_818_715_591_85 * r + 0.119_194_779_794_625_99 * g + 0.950_532_152_249_660_6 * b,
    ]
}

/// CIEXYZ → 線形 RGB(上記の逆行列)
pub fn xyz_to_linear_rgb(x: f64, y: f64, z: f64) -> [f64; 3] {
    [
        3.240_969_941_904_521_3 * x - 1.537_383_177_570_093_5 * y - 0.498_610_760_293_003_3 * z,
        -0.969_243_636_280_879_8 * x + 1.875_967_501_507_720_7 * y + 0.041_555_057_407_175_61 * z,
        0.055_630_079_696_993_61 * x - 0.203_976_958_888_976_57 * y + 1.056_971_514_242_878_6 * z,
    ]
}

/// sRGB 標準の D65 白色点(2 度視野)。
/// 変換行列の行和から厳密に求めることで、白色の a* = b* = 0 を保証する
/// (定数を独立に丸めると行和と微妙にずれ、白で微小な a*/b* が出る)。
const D65_X: f64 = 0.412_390_799_265_959_5 + 0.357_584_339_383_877_96 + 0.180_480_788_401_834_3;
const D65_Y: f64 = 0.212_639_005_871_510_36 + 0.715_168_678_767_755_9 + 0.072_192_315_360_733_71;
const D65_Z: f64 = 0.019_330_818_715_591_85 + 0.119_194_779_794_625_99 + 0.950_532_152_249_660_6;

/// CIEXYZ → CIELAB(D65)
pub fn xyz_to_lab(x: f64, y: f64, z: f64) -> [f64; 3] {
    let fx = lab_f(x / D65_X);
    let fy = lab_f(y / D65_Y);
    let fz = lab_f(z / D65_Z);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// CIELAB(D65) → CIEXYZ
pub fn lab_to_xyz(l: f64, a: f64, b: f64) -> [f64; 3] {
    let fy = (l + 16.0) / 116.0;
    let fx = fy + a / 500.0;
    let fz = fy - b / 200.0;
    [
        D65_X * lab_f_inv(fx),
        D65_Y * lab_f_inv(fy),
        D65_Z * lab_f_inv(fz),
    ]
}

/// sRGB 8bit → CIELAB
pub fn srgb8_to_lab(r: u8, g: u8, b: u8) -> [f64; 3] {
    let lr = srgb8_to_linear(r);
    let lg = srgb8_to_linear(g);
    let lb = srgb8_to_linear(b);
    let [x, y, z] = linear_rgb_to_xyz(lr, lg, lb);
    xyz_to_lab(x, y, z)
}

/// CIELAB → sRGB 8bit(プレビュー描画などホスト表示用の逆変換)
pub fn lab_to_srgb8(l: f64, a: f64, b: f64) -> [u8; 3] {
    let [x, y, z] = lab_to_xyz(l, a, b);
    let [r, g, b] = xyz_to_linear_rgb(x, y, z);
    [linear_to_srgb8(r), linear_to_srgb8(g), linear_to_srgb8(b)]
}

/// 線形 RGB → CIE L*(明度のみ。detail 計算用に Y から直接求める軽量経路)
pub fn linear_rgb_to_lstar(r: f64, g: f64, b: f64) -> f64 {
    let y =
        0.212_639_005_871_510_36 * r + 0.715_168_678_767_755_9 * g + 0.072_192_315_360_733_71 * b;
    lstar_from_y_over_yn(y)
}

/// L*(Y/Yn) の CIE 曲線部(t > (6/29)³ → t^(1/3)、それ以下は線形補間)。
///
/// − 12MP ブロック特徴量は全ピクセル(1,200 万回)で cbrt を呼ぶため、
///   前計算表(4,096 分割 + 線形補間)で置き換える(P1 目標: handoff/05 §7)。
/// − 決定性: 補間誤差は L* 換算で 0.01 未満(f32 格納値の精度未満)。
const LSTAR_SHAPE_SAMPLES: usize = 4096;

fn lstar_from_y_over_yn(y_over_yn: f64) -> f64 {
    // CIE L*: L = 116 × f(Y/Yn) − 16
    const C3: f64 = (6.0 / 29.0) * (6.0 / 29.0) * (6.0 / 29.0);
    if y_over_yn <= C3 {
        // 線形領域(低輝度)は厳密式そのまま(cbrt 不要の軽量パス)
        let f = (1.0 / 3.0) * (29.0 / 6.0) * (29.0 / 6.0) * y_over_yn + 4.0 / 29.0;
        116.0 * f - 16.0
    } else {
        let t = y_over_yn.min(1.0);
        static LUT: std::sync::OnceLock<Box<[f64; LSTAR_SHAPE_SAMPLES]>> =
            std::sync::OnceLock::new();
        let table = LUT.get_or_init(|| {
            let mut table: Box<[f64; LSTAR_SHAPE_SAMPLES]> = Box::new([0.0; LSTAR_SHAPE_SAMPLES]);
            let t_begin = C3;
            let span = 1.0 - t_begin;
            for (i, slot) in table.iter_mut().enumerate() {
                let x = t_begin + span * (i as f64) / ((LSTAR_SHAPE_SAMPLES - 1) as f64);
                *slot = x.cbrt();
            }
            table
        });
        let t_begin = C3;
        let span = 1.0 - t_begin;
        let position = (t - t_begin) / span * ((LSTAR_SHAPE_SAMPLES - 1) as f64);
        let index = (position as usize).min(LSTAR_SHAPE_SAMPLES - 2);
        let frac = position - index as f64;
        let lower = table[index];
        let upper = table[index + 1];
        let f = lower + (upper - lower) * frac;
        116.0 * f - 16.0
    }
}

/// sRGB → 線形 RGB の 256 値ルックアップテーブル(計算量削減用)。
/// ブロック特徴量(grid.rs)とタイル特徴量(tile.rs)で共有する
pub(crate) fn srgb8_linear_lut() -> &'static [f64; 256] {
    static LUT: std::sync::OnceLock<[f64; 256]> = std::sync::OnceLock::new();
    LUT.get_or_init(|| {
        let mut table = [0.0_f64; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            *slot = srgb8_to_linear(i as u8);
        }
        table
    })
}

/// CIE Lab の f 関数
fn lab_f(t: f64) -> f64 {
    const DELTA: f64 = 6.0 / 29.0;
    const DELTA3: f64 = DELTA * DELTA * DELTA;
    if t > DELTA3 {
        t.cbrt()
    } else {
        t / (3.0 * DELTA * DELTA) + 4.0 / 29.0
    }
}

/// CIE Lab の f 関数の逆
fn lab_f_inv(t: f64) -> f64 {
    const DELTA: f64 = 6.0 / 29.0;
    const DELTA3: f64 = DELTA * DELTA * DELTA;
    let t3 = t * t * t;
    if t3 > DELTA3 {
        t3
    } else {
        3.0 * DELTA * DELTA * (t - 4.0 / 29.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    /// 既知値の検証(詳細設計書 11 章: 色変換の単体テスト)
    #[test]
    fn srgb_to_lab_known_values() {
        // 黒 → L*=0, a*=b*=0(白色点を行列行和から求めるため厳密)
        let [l, a, b] = srgb8_to_lab(0, 0, 0);
        assert!(close(l, 0.0, 1e-9) && close(a, 0.0, 1e-9) && close(b, 0.0, 1e-9));

        // 白 → L*=100, a*=b*=0(同上)
        let [l, a, b] = srgb8_to_lab(255, 255, 255);
        assert!(close(l, 100.0, 1e-9) && close(a, 0.0, 1e-9) && close(b, 0.0, 1e-9));

        // sRGB 原色。公表値(例: L*=53.2408)は行列係数の丸め精度に依存して
        // ±0.01 級ブレるため、原色の絶対値は 0.05 の許容で検証する
        // (自己整合性=往復誤差は roundtrip テストで 0.1 未満を厳密検証する)
        let [l, a, b] = srgb8_to_lab(255, 0, 0);
        assert!(close(l, 53.2408, 0.05), "red L* = {l}");
        assert!(close(a, 80.0925, 0.05), "red a* = {a}");
        assert!(close(b, 67.2032, 0.05), "red b* = {b}");

        let [l, a, b] = srgb8_to_lab(0, 255, 0);
        assert!(close(l, 87.7347, 0.05), "green L* = {l}");
        assert!(close(a, -86.1827, 0.05), "green a* = {a}");
        assert!(close(b, 83.1793, 0.05), "green b* = {b}");

        let [l, a, b] = srgb8_to_lab(0, 0, 255);
        assert!(close(l, 32.2970, 0.05), "blue L* = {l}");
        assert!(close(a, 79.1875, 0.05), "blue a* = {a}");
        assert!(close(b, -107.8602, 0.05), "blue b* = {b}");
    }

    /// 往復誤差の検証(詳細設計書 11 章: sRGB↔Lab 往復誤差 < 0.1)
    #[test]
    fn srgb_lab_roundtrip_error_below_0_1() {
        // 8bit 全値ではなく格子点を網羅的に検査(高速化しつつ端数も含める)
        let mut max_error = 0.0_f64;
        for r in [0_u8, 1, 7, 31, 64, 127, 128, 200, 254, 255] {
            for g in [0_u8, 3, 29, 80, 128, 190, 255] {
                for b in [0_u8, 11, 45, 100, 128, 230, 255] {
                    let [l, a, b2] = srgb8_to_lab(r, g, b);
                    let back = lab_to_srgb8(l, a, b2);
                    let error = (f64::from(r) - f64::from(back[0]))
                        .abs()
                        .max((f64::from(g) - f64::from(back[1])).abs())
                        .max((f64::from(b) - f64::from(back[2])).abs());
                    max_error = max_error.max(error);
                }
            }
        }
        assert!(
            max_error < 0.1,
            "roundtrip error {max_error} must be below 0.1"
        );
    }

    #[test]
    fn lstar_matches_full_lab_path() {
        // 線形 RGB → L* の軽量経路は XYZ 経由の L* と一致する
        // (cbrt の前計算・補間を導入した M7 でも、許容誤差内で一致する)
        for (r, g, b) in [(0.0_f64, 0.0, 0.0), (1.0, 1.0, 1.0), (0.3, 0.6, 0.9)] {
            let via_xyz = xyz_to_lab(
                linear_rgb_to_xyz(r, g, b)[0],
                linear_rgb_to_xyz(r, g, b)[1],
                linear_rgb_to_xyz(r, g, b)[2],
            )[0];
            let direct = linear_rgb_to_lstar(r, g, b);
            assert!(close(via_xyz, direct, 0.01));
        }
    }

    #[test]
    fn linear_boundary_values() {
        assert!(close(srgb8_to_linear(0), 0.0, 1e-12));
        assert!(close(srgb8_to_linear(255), 1.0, 1e-12));
        assert_eq!(linear_to_srgb8(0.0), 0);
        assert_eq!(linear_to_srgb8(1.0), 255);
        // 範囲外はクランプされる
        assert_eq!(linear_to_srgb8(-0.5), 0);
        assert_eq!(linear_to_srgb8(1.5), 255);
    }

    #[test]
    fn linear_to_srgb8_matches_exact_formula() {
        // 前計算 + 線形補間 (M7) が厳密式(powf)と 8bit に丸めた値として
        // 同一になること。u8 の全 256 値と、幾つかの中間点も照合する
        for b in 0..=255_u8 {
            let linear = srgb8_to_linear(b);
            let exact = {
                let c = if linear <= 0.003_130_8 {
                    linear * 12.92
                } else {
                    1.055 * linear.powf(1.0 / 2.4) - 0.055
                };
                (c.clamp(0.0, 1.0) * 255.0).round() as u8
            };
            assert_eq!(linear_to_srgb8(linear), b, "u8 {b} roundtrip");
            assert_eq!(linear_to_srgb8(linear), exact, "u8 {b} matches exact");
        }
        // 中間点(バイリニア補間が作る任意の線形値)も照合する
        for i in 0..1000_usize {
            let linear = (i as f64) / 1000.0 + (i as f64) * 0.000_37;
            let mut exact_c = linear.clamp(0.0, 1.0);
            if exact_c > 0.003_130_8 {
                exact_c = (1.055 * exact_c.powf(1.0 / 2.4) - 0.055).clamp(0.0, 1.0);
            } else {
                exact_c *= 12.92;
            }
            let exact_b = (exact_c * 255.0).round() as u8;
            assert_eq!(linear_to_srgb8(linear), exact_b, "mid {i}");
        }
    }
}
