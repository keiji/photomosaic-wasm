//! 合成(P4: 詳細設計書 4.6)。
//!
//! - 各ブロックへ、選択タイルの合成用サムネイルをブロック矩形に
//!   スケーリング描画する(バイリニア。補間は光学的に正しい混合となる
//!   よう線形 RGB 空間で行う)
//! - 色補正: タイルのトーンをブロックのトーンへ寄せる(既定 α=0.85)。
//!   分母の tile_mean はタイルの周囲重み付き代表色(詳細設計書 4.3 の
//!   `mean_lab`)で、α=1 で出力の周囲重み付き平均がブロック平均と一致する。
//!   α を強めるほどタイルの周囲(= ブロック境界に接する領域)がブロック色へ
//!   寄り、背景の継ぎ目・粒状感(つぶつぶ)が目立たなくなる
//!   ```text
//!   線形 RGB 空間で: out = tile_px * ((1 - α) + α * block_mean / tile_mean)
//!   ```
//! - 半端ブロック(画像端)はクリップ描画
//! - 内部計算は f64 に統一し、決定性を保証する(handoff/02 4 章)
//! - 出力ピクセルのアルファは常に 255(ホスト側で白背景合成済みのため)

use crate::color::{lab_to_xyz, linear_to_srgb8, srgb8_linear_lut, xyz_to_linear_rgb};
use crate::config::MosaicConfig;
use crate::grid::{BlockFeature, GridInfo};
use crate::tile::{TileFeature, TilePool};

/// 行範囲 `[row_begin, row_end)` を合成済みバッファへ描画する(P4)。
///
/// - `out`: 画像全体サイズ(width * height * 4)の RGBA バッファ。
///   書き込みは指定行範囲のみ(M5 の部分描画・M6 の差分再合成に再利用する)
/// - `assignments`: 全ブロックの割当表(None = 未確定ブロック)。未確定
///   ブロックは描画せずスキップする(M6 の差分再合成では既存の出力値を保持)
/// - タイルがプールに存在しない場合(実行中の削除など)はそのブロックを
///   描画せずスキップする(出力バッファの既存値を保持)
// M5 の部分描画(行範囲 + プログレスコールバック)を損ねないよう、
// 現状は明示的な引数列を維持する(M5 でコンテキスト構造体への集約を検討)
#[allow(clippy::too_many_arguments)]
pub fn compose_rows(
    out: &mut [u8],
    grid: &GridInfo,
    features: &[BlockFeature],
    assignments: &[Option<u64>],
    pool: &TilePool,
    config: &MosaicConfig,
    row_begin: u32,
    row_end: u32,
) {
    let width = usize::try_from(grid.width).expect("width fits usize");
    let height = usize::try_from(grid.height).expect("height fits usize");
    assert_eq!(
        out.len(),
        width * height * 4,
        "output buffer length mismatch"
    );
    assert_eq!(
        features.len(),
        grid.total_blocks as usize,
        "block feature count mismatch"
    );
    assert_eq!(
        assignments.len(),
        features.len(),
        "assignment count mismatch"
    );
    let row_end = row_end.min(grid.rows);

    for row in row_begin..row_end {
        for col in 0..grid.cols {
            let block_index =
                usize::try_from(row * grid.cols + col).expect("block index fits usize");
            let Some(tile_id) = assignments.get(block_index).copied().flatten() else {
                continue;
            };
            let Some(tile) = pool.feature(tile_id) else {
                continue;
            };
            draw_block_cell(out, grid, &features[block_index], tile, pool, config);
        }
    }
}

/// 全体を一括合成する(P4 の一括実行。M4 で使用)。
pub fn compose(
    grid: &GridInfo,
    features: &[BlockFeature],
    assignments: &[Option<u64>],
    pool: &TilePool,
    config: &MosaicConfig,
) -> Vec<u8> {
    let size = usize::try_from(grid.width).expect("width fits usize")
        * usize::try_from(grid.height).expect("height fits usize")
        * 4;
    let mut out = vec![0_u8; size];
    compose_rows(
        &mut out,
        grid,
        features,
        assignments,
        pool,
        config,
        0,
        grid.rows,
    );
    out
}

/// 1 ブロック(1 セル)を合成して出力バッファへ描く。
///
/// - ブロック矩形は画像端でクリップしたサイズ(半端ブロック対応)
/// - 色補正係数はブロックの CIELAB 平均を線形 RGB へ逆変換した平均で算出する
///   (BlockFeature は CIELAB で保持するため。タイルも同一手法)
fn draw_block_cell(
    out: &mut [u8],
    grid: &GridInfo,
    feature: &BlockFeature,
    tile: &TileFeature,
    pool: &TilePool,
    config: &MosaicConfig,
) {
    let width = usize::try_from(grid.width).expect("width fits usize");
    let block_size = usize::try_from(grid.block_size).expect("block size fits usize");
    let col = usize::try_from(feature.index % grid.cols).expect("col fits usize");
    let row = usize::try_from(feature.index / grid.cols).expect("row fits usize");
    let x0 = col * block_size;
    let y0 = row * block_size;
    // 半端ブロックは画像端でクリップ
    let bw = block_size.min(width - x0);
    let bh = block_size.min(usize::try_from(grid.height).expect("height fits usize") - y0);

    let Some((thumb_w, thumb_h, thumb)) = pool.compose_thumb(tile.id) else {
        return; // 合成サムネイルが無いタイルは描画しない
    };
    if thumb_w == 0 || thumb_h == 0 || bw == 0 || bh == 0 {
        return;
    }

    // 色補正係数(チャンネル毎。詳細設計書 4.6):
    // factor = (1 - α) + α * block_mean / tile_mean(tile_mean < 1/255 は 1)。
    // ともに「代表色」の逆変換で、タイル側は周囲重み付き平均(詳細設計書 4.3)。
    // α=1 で出力の周囲重み付き平均がブロック平均と一致する
    let block_linear = lab_mean_to_linear(&feature.mean_lab);
    let tile_linear = lab_mean_to_linear(&tile.mean_lab);
    let alpha = f64::from(config.color_correct);
    let mut factors = [1.0_f64; 3];
    for (c, factor) in factors.iter_mut().enumerate() {
        if tile_linear[c] >= 1.0 / 255.0 {
            *factor = (1.0 - alpha) + alpha * (block_linear[c] / tile_linear[c]);
        }
    }

    let lut = srgb8_linear_lut();
    let thumb_stride = usize::try_from(thumb_w).expect("thumb width fits usize") * 4;

    let thumb_w_f = f64::from(thumb_w);
    let thumb_h_f = f64::from(thumb_h);
    let bw_f = f64::from(bw as u32);
    let bh_f = f64::from(bh as u32);
    // ブロック座標 → サムネイル座標の一次写像を 1 ブロック 1 回で前計算する。
    // 1 ピクセルごとの除算(2 回/px)を意図して混ぜない(P4 性能: handoff/05 §7)
    //   (x + 0.5) / bw * thumb_w - 0.5 → x * step_x + origin_x
    let step_x = thumb_w_f / bw_f;
    let step_y = thumb_h_f / bh_f;
    let origin_x = 0.5 * step_x - 0.5;
    let origin_y = 0.5 * step_y - 0.5;

    for y in 0..bh {
        // y 行のサムネイル行と補間重みを先に確定させる(x 走査中は不変)
        let src_y = (y as f64) * step_y + origin_y;
        let py0 = src_y.floor();
        let fy = src_y - py0;
        let base_y = py0 as i64;
        let yin = |v: i64| -> usize {
            usize::try_from(v.clamp(0, i64::from(thumb_h) - 1)).expect("clamped to thumb_h")
        };
        let cy0 = yin(base_y);
        let cy1 = yin(base_y + 1);
        let row0 = cy0 * thumb_stride;
        let row1 = cy1 * thumb_stride;
        let wy0 = 1.0 - fy;
        let wy1 = fy;

        for x in 0..bw {
            // タイルサムネイル上の対応位置(ピクセル中心合わせ)。
            let src_x = (x as f64) * step_x + origin_x;
            let px0 = src_x.floor();
            let fx = src_x - px0;
            // 補間する周辺 4 ピクセル(サムネイル境界でクランプ)。
            // floor 済みの有限値であるため as 変換(i64)は決定的で安全
            let base_x = px0 as i64;
            let xin = |v: i64| -> usize {
                usize::try_from(v.clamp(0, i64::from(thumb_w) - 1)).expect("clamped to thumb_w")
            };
            let cx0 = xin(base_x);
            let cx1 = xin(base_x + 1);

            let idx00 = row0 + cx0 * 4;
            let idx10 = row0 + cx1 * 4;
            let idx01 = row1 + cx0 * 4;
            let idx11 = row1 + cx1 * 4;
            let wx0 = 1.0 - fx;
            let wx1 = fx;
            let w00 = wx0 * wy0;
            let w10 = wx1 * wy0;
            let w01 = wx0 * wy1;
            let w11 = wx1 * wy1;

            let offset_out = ((y0 + y) * width + x0 + x) * 4;
            for c in 0..3 {
                // 線形 RGB 空間でバイリニア補間してから色補正を適用する
                let linear = w00 * lut[thumb[idx00 + c] as usize]
                    + w10 * lut[thumb[idx10 + c] as usize]
                    + w01 * lut[thumb[idx01 + c] as usize]
                    + w11 * lut[thumb[idx11 + c] as usize];
                out[offset_out + c] = linear_to_srgb8(linear * factors[c]);
            }
            out[offset_out + 3] = 255;
        }
    }
}

/// CIELAB 平均 → 線形 RGB 平均(P4 色補正用。f64 で計算する)
fn lab_mean_to_linear(lab: &[f32; 3]) -> [f64; 3] {
    let [x, y, z] = lab_to_xyz(f64::from(lab[0]), f64::from(lab[1]), f64::from(lab[2]));
    xyz_to_linear_rgb(x, y, z)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tile::{FEATURE_THUMB, TILE_BORDER_WEIGHT};

    fn thumb_feature_buffer(rgb: [u8; 3]) -> Vec<u8> {
        let mut arg = vec![0_u8; FEATURE_THUMB as usize * FEATURE_THUMB as usize * 4];
        for pixel in arg.as_chunks_mut::<4>().0 {
            pixel[0] = rgb[0];
            pixel[1] = rgb[1];
            pixel[2] = rgb[2];
            pixel[3] = 255;
        }
        arg
    }

    fn thumb_compose_buffer(rgb: [u8; 3]) -> Vec<u8> {
        let mut arg = vec![0_u8; 64 * 64 * 4];
        for pixel in arg.as_chunks_mut::<4>().0 {
            pixel[0] = rgb[0];
            pixel[1] = rgb[1];
            pixel[2] = rgb[2];
            pixel[3] = 255;
        }
        arg
    }

    /// 単色タイルをプールへ登録するヘルパー(add_tile 経由で寸法検証も通す)
    fn pool_with_flat_tile(id: u64, rgb: [u8; 3]) -> TilePool {
        let mut pool = TilePool::new();
        pool.add_tile(
            id,
            &thumb_feature_buffer(rgb),
            &thumb_compose_buffer(rgb),
            64,
            64,
        )
        .expect("tile registration should succeed");
        pool
    }

    /// 全ブロックが同じ特徴量の N 個(単一格子)
    fn uniform_grid(
        width: u32,
        height: u32,
        block_size: u32,
        lab: [f32; 3],
    ) -> (GridInfo, Vec<BlockFeature>) {
        let grid = crate::grid::compute_grid_info(width, height, block_size);
        let features: Vec<BlockFeature> = (0..grid.total_blocks)
            .map(|index| BlockFeature {
                index,
                mean_lab: lab,
                detail: 0.0,
                weight: block_size as f32 * block_size as f32,
            })
            .collect();
        (grid, features)
    }

    #[test]
    fn compose_fills_every_pixel_opaque() {
        // 全ピクセルが描画され、出力のアルファが 255 になること(白背景仕様)
        let (grid, features) = uniform_grid(24, 24, 24, [50.0, 0.0, 0.0]);
        let pool = pool_with_flat_tile(1, [200, 100, 50]);
        let assignments = vec![Some(1_u64); grid.total_blocks as usize];
        let out = compose(
            &grid,
            &features,
            &assignments,
            &pool,
            &MosaicConfig::default(),
        );
        assert_eq!(out.len(), 24 * 24 * 4);
        assert!(out.as_chunks::<4>().0.iter().all(|px| px[3] == 255));
    }

    #[test]
    fn color_correction_strength_zero_keeps_tile_colors() {
        // α=0: 色補正なし(タイル原色のパッチワーク)
        let (grid, features) = uniform_grid(24, 24, 24, [90.0, -20.0, 30.0]);
        let pool = pool_with_flat_tile(1, [180, 60, 30]);
        let assignments = vec![Some(1_u64); grid.total_blocks as usize];
        let config = MosaicConfig {
            color_correct: 0.0,
            ..MosaicConfig::default()
        };
        let out = compose(&grid, &features, &assignments, &pool, &config);
        assert!(out
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| px[..3] == [180, 60, 30]));
    }

    #[test]
    fn color_correction_full_strength_matches_block_tone() {
        // α=1: 出力の線形 RGB 平均がブロック平均と一致する(トーンの完全一致)。
        // 単色タイルでは周囲重み付き平均が全体平均と一致するため、
        // 従来どおり「出力全体の平均」で検証できる
        let (grid, features) = uniform_grid(24, 24, 24, [90.0, -20.0, 30.0]);
        let pool = pool_with_flat_tile(1, [180, 60, 30]);
        let assignments = vec![Some(1_u64); grid.total_blocks as usize];
        let config = MosaicConfig {
            color_correct: 1.0,
            ..MosaicConfig::default()
        };
        let out = compose(&grid, &features, &assignments, &pool, &config);

        let mut sum = [0.0_f64; 3];
        for pixel in out.as_chunks::<4>().0 {
            for (c, slot) in sum.iter_mut().enumerate() {
                *slot += crate::color::srgb8_to_linear(pixel[c]);
            }
        }
        let n = f64::from(24 * 24);
        let mean_out = [sum[0] / n, sum[1] / n, sum[2] / n];
        let block_xyz = lab_to_xyz(
            f64::from(features[0].mean_lab[0]),
            f64::from(features[0].mean_lab[1]),
            f64::from(features[0].mean_lab[2]),
        );
        let block_linear = xyz_to_linear_rgb(block_xyz[0], block_xyz[1], block_xyz[2]);
        for c in 0..3 {
            assert!(
                (mean_out[c] - block_linear[c]).abs() < 0.01,
                "channel {c}: output mean {mean_out:?} vs block mean {block_linear:?}"
            );
        }
    }

    #[test]
    fn color_correction_tracks_tile_periphery_to_block_tone() {
        // 詳細設計書 4.6: 分母の tile_mean はタイルの周囲重み付き代表色(4.3)。
        // α=1 で「中央に被写体・周囲に背景」のタイルでも、出力の周囲重み付き
        // 平均がブロック平均と一致し、周囲(= ブロック境界に接する領域)が
        // ブロック色へ寄る。中央の被写体は暗いまま残る(モザイクの模様として保持)
        let block_lab = crate::color::srgb8_to_lab(120, 120, 120);
        let (grid, features) = uniform_grid(
            24,
            24,
            24,
            [
                block_lab[0] as f32,
                block_lab[1] as f32,
                block_lab[2] as f32,
            ],
        );

        // 特徴量サムネイル(32×32)・合成サムネイル(64×64)とも同一構図
        // (中央区画が暗い被写体 40、周囲が明るい背景 220)
        let c0 = FEATURE_THUMB / 4;
        let c1 = FEATURE_THUMB - c0;
        let (cz0, cz1) = (c0 as usize, c1 as usize);
        let mut feature_arg = thumb_feature_buffer([220, 220, 220]);
        for (i, pixel) in feature_arg.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let x = i % FEATURE_THUMB as usize;
            let y = i / FEATURE_THUMB as usize;
            let v = if (cz0..cz1).contains(&x) && (cz0..cz1).contains(&y) {
                40
            } else {
                220
            };
            pixel[0] = v;
            pixel[1] = v;
            pixel[2] = v;
        }
        let mut compose_arg = thumb_compose_buffer([220, 220, 220]);
        for (i, pixel) in compose_arg.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let x = i % 64;
            let y = i / 64;
            let v = if (16..48).contains(&x) && (16..48).contains(&y) {
                40
            } else {
                220
            };
            pixel[0] = v;
            pixel[1] = v;
            pixel[2] = v;
        }
        let mut pool = TilePool::new();
        pool.add_tile(1, &feature_arg, &compose_arg, 64, 64)
            .expect("tile registration should succeed");
        let assignments = vec![Some(1_u64); grid.total_blocks as usize];
        let config = MosaicConfig {
            color_correct: 1.0,
            ..MosaicConfig::default()
        };
        let out = compose(&grid, &features, &assignments, &pool, &config);

        // 出力(24×24)の周囲重み付き平均(中央区画 [6,18) は重み 1、周囲は
        // TILE_BORDER_WEIGHT)がブロック平均(線形 RGB)と一致する
        let lut = srgb8_linear_lut();
        let mut weighted_sum = [0.0_f64; 3];
        let mut total_weight = 0.0_f64;
        for (i, pixel) in out.as_chunks::<4>().0.iter().enumerate() {
            let x = i % 24;
            let y = i / 24;
            let in_center = (6..18).contains(&x) && (6..18).contains(&y);
            let weight = if in_center { 1.0 } else { TILE_BORDER_WEIGHT };
            for (c, slot) in weighted_sum.iter_mut().enumerate() {
                *slot += lut[pixel[c] as usize] * weight;
            }
            total_weight += weight;
        }
        let block_xyz = lab_to_xyz(
            f64::from(features[0].mean_lab[0]),
            f64::from(features[0].mean_lab[1]),
            f64::from(features[0].mean_lab[2]),
        );
        let block_linear = xyz_to_linear_rgb(block_xyz[0], block_xyz[1], block_xyz[2]);
        for c in 0..3 {
            let mean = weighted_sum[c] / total_weight;
            assert!(
                (mean - block_linear[c]).abs() < 0.01,
                "channel {c}: weighted mean {mean} vs block {block_linear:?}"
            );
        }

        // 周囲画素(コーナー)はブロック色(sRGB 120 相当)に近く、中央画素は
        // 暗いまま(被写体の明度差は相対的に保持される)
        let at = |x: usize, y: usize| -> u8 { out[(y * 24 + x) * 4] };
        assert!(
            (i32::from(at(0, 0)) - 120).abs() <= 10,
            "corner = {}",
            at(0, 0)
        );
        assert!(
            (i32::from(at(23, 23)) - 120).abs() <= 10,
            "corner = {}",
            at(23, 23)
        );
        assert!(
            at(12, 12) < 60,
            "center keeps the subject dark, got {}",
            at(12, 12)
        );
    }

    #[test]
    fn partial_edge_blocks_are_clipped() {
        // 30x30 / block 24 → 右下が半端(6x6)。クリップ描画で全体が覆われること
        let (grid, features) = uniform_grid(30, 30, 24, [50.0, 0.0, 0.0]);
        let pool = pool_with_flat_tile(1, [100, 100, 100]);
        let assignments = vec![Some(1_u64); grid.total_blocks as usize];
        let config = MosaicConfig {
            color_correct: 0.0,
            ..MosaicConfig::default()
        };
        let out = compose(&grid, &features, &assignments, &pool, &config);
        assert_eq!(out.len(), 30 * 30 * 4);
        assert!(out
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| px[..3] == [100, 100, 100] && px[3] == 255));
    }

    #[test]
    fn non_uniform_tile_is_scaled_bilinear() {
        // 左半分黒・右半分白のタイル: α=0 で描くとブロック内にスケーリングした
        // 明度差が現れ、左端が黒寄り・右端が白寄りになる(バイリニアの確認)
        let (grid, features) = uniform_grid(16, 16, 16, [50.0, 0.0, 0.0]);
        let mut pool = TilePool::new();
        let mut compose_arg = thumb_compose_buffer([0, 0, 0]);
        for (i, pixel) in compose_arg.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let x = (i % 64) as u8;
            let v = if x < 32 { 0 } else { 255 };
            pixel[0] = v;
            pixel[1] = v;
            pixel[2] = v;
            pixel[3] = 255;
        }
        let feature_arg = thumb_feature_buffer([128, 128, 128]);
        pool.add_tile(1, &feature_arg, &compose_arg, 64, 64)
            .expect("tile registration should succeed");
        let assignments = vec![Some(1_u64); grid.total_blocks as usize];
        let config = MosaicConfig {
            color_correct: 0.0,
            ..MosaicConfig::default()
        };
        let out = compose(&grid, &features, &assignments, &pool, &config);
        let at = |x: usize, y: usize| -> [u8; 3] {
            let offset = (y * 16 + x) * 4;
            [out[offset], out[offset + 1], out[offset + 2]]
        };
        assert!(
            at(0, 0)[0] <= 5,
            "left edge should be black, got {:?}",
            at(0, 0)
        );
        assert!(
            at(15, 0)[0] >= 250,
            "right edge should be white, got {:?}",
            at(15, 0)
        );
    }

    #[test]
    fn compose_rows_only_writes_requested_range() {
        // 行範囲指定の合成: 未指定行は既存値を保持する(M5 の部分描画に備える)
        let (grid, features) = uniform_grid(24, 48, 24, [50.0, 0.0, 0.0]);
        let pool = pool_with_flat_tile(1, [100, 100, 100]);
        let config = MosaicConfig {
            color_correct: 0.0,
            ..MosaicConfig::default()
        };
        let mut out = vec![7_u8; 24 * 48 * 4];
        let assignments = vec![Some(1_u64); grid.total_blocks as usize];
        compose_rows(
            &mut out,
            &grid,
            &features,
            &assignments,
            &pool,
            &config,
            0,
            1,
        );
        // 1 行目(0..24 px)のみ書き換わり、以降は 7 のまま
        assert!(out[..24 * 24 * 4]
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| px[..3] == [100, 100, 100]));
        assert!(out[24 * 24 * 4..].iter().all(|&b| b == 7));
    }

    #[test]
    fn missing_tile_is_skipped() {
        // 未確定ブロック(None)の割当は描画せずスキップし、出力の既存値を保持する
        // (48x24 / block 24 → 2x1 ブロック。ブロック 0 を未確定にする)
        let (grid, features) = uniform_grid(48, 24, 24, [50.0, 0.0, 0.0]);
        let pool = pool_with_flat_tile(1, [100, 100, 100]);
        let mut assignments = vec![Some(1_u64); grid.total_blocks as usize];
        assignments[0] = None; // 未確定ブロック
        let mut out = vec![7_u8; 48 * 24 * 4];
        compose_rows(
            &mut out,
            &grid,
            &features,
            &assignments,
            &pool,
            &MosaicConfig {
                color_correct: 0.0,
                ..MosaicConfig::default()
            },
            0,
            grid.rows,
        );
        // ブロック 0 はスキップ(7 のまま)、ブロック 1 は描画済み
        assert!(out[..24 * 4].iter().all(|&b| b == 7));
        assert_eq!(out[24 * 4], 100);
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

    /// ゴールデン検証(詳細設計書 11 章: 固定入力 → 決定的出力をハッシュ比較)。
    /// 出力が変わる変更では、このハッシュの更新が必要
    #[test]
    fn golden_hash_of_fixed_input() {
        // メイン画像 32x32 / ブロック 8 → 4x4 ブロック
        let sample = |x: u32, y: u32| -> [u8; 3] {
            [
                ((x * 7 + y * 13) % 256) as u8,
                ((x * 5 + y * 11 + 64) % 256) as u8,
                ((x * 3 + y * 17 + 128) % 256) as u8,
            ]
        };
        let mut rgba = Vec::with_capacity(32 * 32 * 4);
        for y in 0..32_u32 {
            for x in 0..32_u32 {
                let [r, g, b] = sample(x, y);
                rgba.extend_from_slice(&[r, g, b, 255]);
            }
        }
        let grid = crate::grid::compute_grid_info(32, 32, 8);
        let features = crate::grid::compute_block_features(&rgba, 32, 32, 8);

        // タイル 4 枚(特徴量サムネイル 32x32・合成サムネイル 64x32 とも決定的な合成値)
        let mut pool = TilePool::new();
        for tile_id in 1..=4_u64 {
            let mut feature_arg = vec![0_u8; FEATURE_THUMB as usize * FEATURE_THUMB as usize * 4];
            for (i, pixel) in feature_arg.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let x = i % FEATURE_THUMB as usize;
                let y = i / FEATURE_THUMB as usize;
                pixel[0] = ((x * 3 + y * 5 + tile_id as usize * 11) % 256) as u8;
                pixel[1] = ((x * 11 + y * 3 + tile_id as usize * 7) % 256) as u8;
                pixel[2] = ((x * 17 + y * 13 + tile_id as usize * 29) % 256) as u8;
                pixel[3] = 255;
            }
            let mut compose_arg = vec![0_u8; 64 * 32 * 4];
            for (i, pixel) in compose_arg.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let x = i % 64;
                let y = i / 64;
                pixel[0] = ((x * 5 + y * 7 + tile_id as usize * 13) % 256) as u8;
                pixel[1] = ((x * 13 + y * 5 + tile_id as usize * 3) % 256) as u8;
                pixel[2] = ((x * 29 + y * 11 + tile_id as usize * 17) % 256) as u8;
                pixel[3] = 255;
            }
            pool.add_tile(tile_id, &feature_arg, &compose_arg, 64, 32)
                .expect("tile registration should succeed");
        }

        let config = MosaicConfig::default();
        pool.reset_usage();
        let matches = crate::match_engine::match_blocks(&features, grid.cols, &mut pool, &config);
        let assignments: Vec<Option<u64>> = matches.iter().map(|m| Some(m.tile_id)).collect();
        let out = compose(&grid, &features, &assignments, &pool, &config);
        assert_eq!(out.len(), 32 * 32 * 4);
        assert_eq!(
            fnv1a64(&out),
            0x766A_173A_06CF_D149, // 重複グループ(使用ペナルティのグループ合計化)の導入でマッチが変化
            "golden hash mismatch: inspect intentional spec changes and update this value"
        );
    }
}
