//! ブロック分割・ブロック特徴量(P1 メイン画像解析: 詳細設計書 4.2)。
//!
//! - グリッド: cols = ceil(w / block_size), rows = ceil(h / block_size)。
//!   右端・下端は半端サイズのブロックになり得る(クリップ描画)
//! - 各ブロックの特徴量:
//!   - 線形 RGB で画素平均を算出し、CIELAB(D65)へ変換(`mean_lab`)
//!   - ブロック内 L*(明度)の標準偏差(`detail`、0..128)
//!   - 有効画素数を `weight` に記録(半端ブロックは block_size² 未満)

use crate::color::linear_rgb_to_lstar;

/// ブロックサイズの既定値(詳細設計書 5 章 block_size)
pub const DEFAULT_BLOCK_SIZE: u32 = 24;

/// グリッド情報(詳細設計書 3 章 GridInfo)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridInfo {
    /// メイン画像(解析用正規化後)サイズ
    pub width: u32,
    pub height: u32,
    /// 1 ブロックの辺長 px
    pub block_size: u32,
    /// ブロック数(最終列/行は半端ブロック含む)
    pub cols: u32,
    pub rows: u32,
    /// 全体ブロック数 = cols * rows(進捗バーの分母)
    pub total_blocks: u32,
}

/// グリッド計算(詳細設計書 4.2 の 1)
pub fn compute_grid_info(width: u32, height: u32, block_size: u32) -> GridInfo {
    assert!(width > 0 && height > 0, "image size must be positive");
    assert!(block_size > 0, "block size must be positive");
    let cols = width.div_ceil(block_size);
    let rows = height.div_ceil(block_size);
    GridInfo {
        width,
        height,
        block_size,
        cols,
        rows,
        total_blocks: cols * rows,
    }
}

/// ブロック特徴量(詳細設計書 3 章 BlockFeature)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BlockFeature {
    /// ブロック番号 = row * cols + col
    pub index: u32,
    /// CIELAB 平均 (L*, a*, b*)
    pub mean_lab: [f32; 3],
    /// ブロック内 L* の標準偏差(0..128)
    pub detail: f32,
    /// 有効画素数(半端ブロックは block_size² 未満)
    pub weight: f32,
}

/// メイン画像全体のブロック特徴量を計算する(P1)。
///
/// `rgba` は R→G→B→A 順・行優先の 1 ピクセル 4 バイト。長さは width * height * 4。
pub fn compute_block_features(
    rgba: &[u8],
    width: u32,
    height: u32,
    block_size: u32,
) -> Vec<BlockFeature> {
    let grid = compute_grid_info(width, height, block_size);
    assert_eq!(
        rgba.len(),
        usize::try_from(width * height).expect("pixel count fits usize") * 4,
        "rgba buffer length mismatch"
    );

    let lut = crate::color::srgb8_linear_lut();
    let mut features = Vec::with_capacity(grid.total_blocks as usize);

    for row in 0..grid.rows {
        for col in 0..grid.cols {
            let x0 = usize::try_from(col * block_size).expect("col fits usize");
            let y0 = usize::try_from(row * block_size).expect("row fits usize");
            // 半端ブロックは画像端でクリップ
            let w = usize::try_from(block_size).expect("block size fits usize");
            let bw = w.min(usize::try_from(width).expect("width fits usize") - x0);
            let bh = w.min(usize::try_from(height).expect("height fits usize") - y0);

            let mut sum_linear = [0.0_f64; 3];
            let mut sum_lstar = 0.0_f64;
            let mut sum_lstar_sq = 0.0_f64;
            let count = bw * bh;

            for y in y0..y0 + bh {
                let row_offset = y * usize::try_from(width).expect("width fits usize") * 4;
                for x in x0..x0 + bw {
                    let offset = row_offset + x * 4;
                    let lr = lut[rgba[offset] as usize];
                    let lg = lut[rgba[offset + 1] as usize];
                    let lb = lut[rgba[offset + 2] as usize];

                    // 線形 RGB で画素平均を取る(sRGB のまま平均しない)
                    sum_linear[0] += lr;
                    sum_linear[1] += lg;
                    sum_linear[2] += lb;

                    // detail 用: 画素ごとの L*
                    let lstar = linear_rgb_to_lstar(lr, lg, lb);
                    sum_lstar += lstar;
                    sum_lstar_sq += lstar * lstar;
                }
            }

            let n = f64::from(count as u32);
            let mean_linear = [sum_linear[0] / n, sum_linear[1] / n, sum_linear[2] / n];
            let mean_xyz =
                crate::color::linear_rgb_to_xyz(mean_linear[0], mean_linear[1], mean_linear[2]);
            let mean_lab = crate::color::xyz_to_lab(mean_xyz[0], mean_xyz[1], mean_xyz[2]);

            // detail: L* の母標準偏差(平均 L* 回りの分散。丸めによる負値は 0 にクランプ)
            let mean_l = sum_lstar / n;
            let variance = (sum_lstar_sq / n - mean_l * mean_l).max(0.0);

            features.push(BlockFeature {
                index: row * grid.cols + col,
                mean_lab: [mean_lab[0] as f32, mean_lab[1] as f32, mean_lab[2] as f32],
                detail: variance.sqrt() as f32,
                weight: n as f32,
            });
        }
    }

    features
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::srgb8_to_lab;

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    #[test]
    fn grid_info_matches_spec() {
        let grid = compute_grid_info(240, 120, 24);
        assert_eq!(grid.cols, 10);
        assert_eq!(grid.rows, 5);
        assert_eq!(grid.total_blocks, 50);

        // 半端ブロックは ceil(詳細設計書 4.2)
        let grid = compute_grid_info(100, 101, 24);
        assert_eq!(grid.cols, 5);
        assert_eq!(grid.rows, 5);
        assert_eq!(grid.total_blocks, 25);
    }

    #[test]
    #[should_panic]
    fn grid_info_rejects_zero_size() {
        compute_grid_info(0, 10, 24);
    }

    #[test]
    fn block_features_on_uniform_image() {
        // 単色(マゼンタ)画像 24x24、ブロック 24 → 1 ブロック
        let mut rgba = Vec::new();
        for _ in 0..24 * 24 {
            rgba.extend_from_slice(&[255, 0, 255, 255]);
        }
        let features = compute_block_features(&rgba, 24, 24, 24);
        assert_eq!(features.len(), 1);
        let f = &features[0];
        assert_eq!(f.index, 0);
        assert!(close(f64::from(f.weight), 576.0, 1e-6));
        // 単色なので detail は 0(f64 累積の丸め残差が sqrt で増幅されるため 1e-4 許容。
        // 実用スケールは 0..128)
        assert!(close(f64::from(f.detail), 0.0, 1e-4));
        // mean_lab は単色の sRGB→Lab と一致する
        let expected = srgb8_to_lab(255, 0, 255);
        assert!(close(f64::from(f.mean_lab[0]), expected[0], 1e-3));
        assert!(close(f64::from(f.mean_lab[1]), expected[1], 1e-3));
        assert!(close(f64::from(f.mean_lab[2]), expected[2], 1e-3));
    }

    #[test]
    fn partial_blocks_have_reduced_weight() {
        // 30x30、ブロック 24 → 2x2 ブロック(右下だけ 6x6=36 画素)
        let mut rgba = Vec::new();
        for _ in 0..30 * 30 {
            rgba.extend_from_slice(&[128, 128, 128, 255]);
        }
        let features = compute_block_features(&rgba, 30, 30, 24);
        assert_eq!(features.len(), 4);
        assert!(close(f64::from(features[0].weight), 576.0, 1e-6));
        assert!(close(f64::from(features[3].weight), 36.0, 1e-6));
    }

    #[test]
    fn detail_reflects_contrast() {
        // 左半分黒・右半分白のブロックは detail が大きい
        let mut rgba = Vec::new();
        for _y in 0..8 {
            for x in 0..8 {
                let v = if x < 4 { 0 } else { 255 };
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let features = compute_block_features(&rgba, 8, 8, 8);
        assert_eq!(features.len(), 1);
        // 半々の明度反転なので L* はほぼ 0 と 100 の 2 値 → 標準偏差は 50 前後
        assert!(features[0].detail > 40.0, "detail = {}", features[0].detail);
    }

    /// FNV-1a 64bit(依存なしの決定的ハッシュ。ゴールデン比較用)
    fn fnv1a64(bytes: &[u8]) -> u64 {
        const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const PRIME: u64 = 0x0000_0100_0000_01b3;
        let mut hash = OFFSET;
        for &byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(PRIME);
        }
        hash
    }

    fn feature_bytes(features: &[BlockFeature]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for f in features {
            bytes.extend_from_slice(&f.index.to_le_bytes());
            for v in f.mean_lab {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            bytes.extend_from_slice(&f.detail.to_le_bytes());
            bytes.extend_from_slice(&f.weight.to_le_bytes());
        }
        bytes
    }

    /// 決定的なテスト画像を生成する(乱数シードなし。x/y の線形組合せのみ)
    fn golden_test_image(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let r = ((x * 7 + y * 13) % 256) as u8;
                let g = ((x * 5 + y * 11 + 64) % 256) as u8;
                let b = ((x * 3 + y * 17 + 128) % 256) as u8;
                rgba.extend_from_slice(&[r, g, b, 255]);
            }
        }
        rgba
    }

    /// ゴールデン検証(詳細設計書 11 章): 固定入力 → 決定的出力をハッシュ比較する。
    /// 出力が変わる変更(意図した仕様変更を含む)では、このハッシュの更新が必要。
    #[test]
    fn golden_hash_of_fixed_input() {
        let image = golden_test_image(32, 32);
        let features = compute_block_features(&image, 32, 32, 8);
        assert_eq!(features.len(), 16);

        // 同一入力から同一出力が得られること(決定性)
        let again = compute_block_features(&image, 32, 32, 8);
        assert_eq!(features, again);

        // ゴールデンハッシュ
        assert_eq!(
            fnv1a64(&feature_bytes(&features)),
            0x1CDC_47E8_B287_E331,
            "golden hash mismatch: inspect intentional spec changes and update this value"
        );
    }
}
