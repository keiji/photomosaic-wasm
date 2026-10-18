//! マッチング(P3: 詳細設計書 4.4)。
//!
//! - 各ブロックに対し、タイルプールから距離最小のタイルを選ぶ
//!   `D = w_c * ΔE76 + w_d * |detail差| + λ * usage + n_p * neighbor_same`
//! - 使用ペナルティの λ でタイル群を均等に散らばらせ、全タイルの使用回数が
//!   usage_cap に達したら一括リセットする(スタック防止)
//! - ΔE76 < identical_de(視覚上ほぼ同一)の候補が複数ある場合は
//!   detail が大きい方(情報量が多い方)を優先する
//! - 走査順は「ブロック番号昇順 × タイル ID 昇順」に固定し、同一入力に対して
//!   決定的な結果を保証する(handoff/02 4 章の決定性指針)

use crate::config::MosaicConfig;
use crate::grid::BlockFeature;
use crate::tile::{TileFeature, TilePool};

/// マッチ結果(詳細設計書 3 章 MatchResult)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MatchResult {
    /// ブロック番号 = row * cols + col
    pub block_index: u32,
    /// 割り当てたタイル ID
    pub tile_id: u64,
}

/// ΔE76: CIELAB 間のユークリッド距離。座標は (L*, a*, b*) の f32 3 次元
pub fn delta_e76(a: &[f32; 3], b: &[f32; 3]) -> f32 {
    let dl = f64::from(a[0]) - f64::from(b[0]);
    let da = f64::from(a[1]) - f64::from(b[1]);
    let db = f64::from(a[2]) - f64::from(b[2]);
    (dl * dl + da * da + db * db).sqrt() as f32
}

/// 1 ブロックに対する距離評価(詳細設計書 4.4 の距離関数)。
///
/// `neighbor_same` は直上・直左のいずれかと同一タイルのとき `true`
/// (ペナルティ n_p を距離へ加算する)。
pub fn distance(
    block: &BlockFeature,
    tile: &TileFeature,
    usage: u32,
    neighbor_same: bool,
    config: &MosaicConfig,
) -> f32 {
    let color_term = f64::from(config.w_c * delta_e76(&block.mean_lab, &tile.mean_lab));
    let detail_term = f64::from(config.w_d * (block.detail - tile.detail).abs());
    let usage_term = f64::from(config.usage_penalty) * f64::from(usage);
    let neighbor_term = f64::from(if neighbor_same {
        config.neighbor_penalty
    } else {
        0.0
    });
    (color_term + detail_term + usage_term + neighbor_term) as f32
}

/// 全ブロックをマッチングする(P3)。
///
/// - `cols` は隣接参照(直上 = block_index - cols、直左 = block_index - 1)に使用
/// - 選択タイルの使用回数を [`TilePool`] 側で加算する
/// - タイルプールが空の場合は空の結果を返す(タイル 0 枚の run は UI 層で案内する)
pub fn match_blocks(
    blocks: &[BlockFeature],
    cols: u32,
    pool: &mut TilePool,
    config: &MosaicConfig,
) -> Vec<MatchResult> {
    let mut results: Vec<MatchResult> = Vec::with_capacity(blocks.len());
    if pool.tile_count() == 0 || cols == 0 {
        return results;
    }

    // 選択済み割当(位置 i のタイル ID)。直上・直左の同一タイル判定に使う
    let mut assigned: Vec<u64> = Vec::with_capacity(blocks.len());

    for (i, block) in blocks.iter().enumerate() {
        // 全タイルの使用回数が usage_cap に達したら一括リセット(スタック防止)
        if pool.all_usage_reached(config.usage_cap) {
            pool.reset_usage();
        }

        let block_index = u32::try_from(i).expect("block index fits u32");
        let col = block_index % cols;
        let left_id = if col > 0 { Some(assigned[i - 1]) } else { None };
        let above_id = if i >= cols as usize {
            Some(assigned[i - cols as usize])
        } else {
            None
        };

        // 各タイルの距離を評価し最小を選ぶ(ID 昇順走査 → 決定的)。
        // あわせて「視覚上同一(ΔE76 < identical_de)」の候補の中で detail 最大の
        // タイルを追跡し、存在すれば距離最小より優先して選ぶ。
        // TileFeature は Copy のため値で保持し、プールの可変借用と衝突させない
        let mut best: Option<(f32, TileFeature)> = None;
        let mut near_best: Option<(f32, TileFeature)> = None;

        for tile in pool.features() {
            let de = delta_e76(&block.mean_lab, &tile.mean_lab);
            let neighbor_same = left_id == Some(tile.id) || above_id == Some(tile.id);
            let d = distance(block, tile, tile.usage, neighbor_same, config);

            if best.is_none_or(|(best_d, _)| d < best_d) {
                best = Some((d, *tile));
            }
            if de < config.identical_de {
                // detail 同点のときは距離(usage/隣接ペナルティ含む)で比較する。
                // 比較は `<` のみで行い、同点は先着(ID 小)を保持する(決定性)
                let take_near = match near_best {
                    None => true,
                    Some((near_d, near_tile)) => {
                        tile.detail > near_tile.detail
                            || (tile.detail == near_tile.detail && d < near_d)
                    }
                };
                if take_near {
                    near_best = Some((d, *tile));
                }
            }
        }

        let chosen_tile = near_best.or(best).expect("pool is non-empty").1;
        pool.bump_usage(chosen_tile.id);
        assigned.push(chosen_tile.id);
        results.push(MatchResult {
            block_index: block.index,
            tile_id: chosen_tile.id,
        });
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tile::{TileFeature, TilePool};

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
    }

    fn block(lab: [f32; 3], detail: f32, index: u32) -> BlockFeature {
        BlockFeature {
            index,
            mean_lab: lab,
            detail,
            weight: 576.0,
        }
    }

    /// プールへ直接特徴量を登録するヘルパー((mean_lab, detail, id) の並び)
    fn pool_with_tiles(tiles: &[([f32; 3], f32, u64)]) -> TilePool {
        let mut pool = TilePool::new();
        for &(lab, detail, id) in tiles {
            pool.insert_feature_for_test(TileFeature {
                id,
                thumb_w: 64,
                thumb_h: 64,
                mean_lab: lab,
                detail,
                usage: 0,
            });
        }
        pool
    }

    /// 同一ブロック特徴量 N 個を生成する
    fn uniform_blocks(lab: [f32; 3], detail: f32, count: u32) -> Vec<BlockFeature> {
        (0..count).map(|index| block(lab, detail, index)).collect()
    }

    #[test]
    fn delta_e76_matches_manual_computation() {
        let a: [f32; 3] = [50.0, 10.0, -10.0];
        let b: [f32; 3] = [52.0, 8.0, -13.0];
        // sqrt(4 + 4 + 9) = sqrt(17) ≈ 4.123
        assert!(close(delta_e76(&a, &b), (f64::from(17.0f32)).sqrt() as f32));
        assert_eq!(delta_e76(&a, &a), 0.0);
    }

    #[test]
    fn distance_terms_contribute_separately() {
        let config = MosaicConfig::default();
        let block = block([50.0, 0.0, 0.0], 4.0, 0);
        let tile_same_lab_higher_detail = TileFeature {
            id: 1,
            thumb_w: 64,
            thumb_h: 64,
            mean_lab: [50.0, 0.0, 0.0],
            detail: 10.0,
            usage: 0,
        };
        // ΔE76 = 0、detail 差 = 6、usage 2 → 0.25*6 + 0.35*2 = 1.5 + 0.7 = 2.2
        assert!(close(
            distance(&block, &tile_same_lab_higher_detail, 2, false, &config),
            2.2
        ));
        // 隣接ペナルティの加算(n_p = 0.5)
        assert!(close(
            distance(&block, &tile_same_lab_higher_detail, 2, true, &config),
            2.7
        ));
    }

    #[test]
    fn match_blocks_picks_nearest_color() {
        // ブロックに対し赤タイルと緑タイル → 赤が選ばれる
        let red: [f32; 3] = [53.0, 80.0, 67.0];
        let green: [f32; 3] = [87.0, -86.0, 83.0];
        let blocks = uniform_blocks(red, 5.0, 1);
        let mut pool = pool_with_tiles(&[(green, 5.0, 1), (red, 5.0, 2)]);
        let config = MosaicConfig::default();

        let results = match_blocks(&blocks, 1, &mut pool, &config);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].block_index, 0);
        assert_eq!(results[0].tile_id, 2, "red tile must be chosen");
    }

    #[test]
    fn usage_penalty_changes_ranking() {
        // 距離関数の性質(詳細設計書 11 章): 使用ペナルティで順位が変わること。
        // 候補 2 枚とも視覚上同一でない距離(ΔE76 >= identical_de)にして、
        // identical タイブレークの影響を受けない条件で検証する
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let near: [f32; 3] = [52.5, 0.0, 0.0]; // ΔE76 = 2.5
        let far: [f32; 3] = [55.0, 0.0, 0.0]; // ΔE76 = 5
                                              // near を事前に 12 回使用した状態(λ=0.35 → ペナルティ 4.2)。
                                              // D(near) = 2.5 + 4.2 = 6.7 > D(far) = 5.0 → far が逆転する
        let mut pool = pool_with_tiles(&[(near, 5.0, 1), (far, 5.0, 2)]);
        for _ in 0..12 {
            pool.bump_usage(1);
        }
        let config = MosaicConfig::default();
        let results = match_blocks(&uniform_blocks(target, 5.0, 1), 1, &mut pool, &config);
        assert_eq!(results[0].tile_id, 2, "usage penalty must flip ranking");
    }

    #[test]
    fn usage_cap_resets_all_usage_when_reached() {
        // 同色 2 枚(ΔE 0.5、detail 同点)は使用ペナルティで交互に選ばれ、
        // 全タイル usage が cap に達した時点で一括リセットされる(スタック防止)
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let near_a: [f32; 3] = [50.5, 0.0, 0.0];
        let near_b: [f32; 3] = [50.5, 0.0, 0.0];
        let blocks = uniform_blocks(target, 0.0, 5);
        let config = MosaicConfig {
            usage_cap: 1,
            ..MosaicConfig::default()
        };
        let mut pool = pool_with_tiles(&[(near_a, 0.0, 1), (near_b, 0.0, 2)]);

        let results = match_blocks(&blocks, 1, &mut pool, &config);
        assert_eq!(results.len(), 5);
        // cap 到達 → 一括リセット後もマッチングが継続する(両タイルが選ばれ続ける)
        for result in &results {
            assert!(result.tile_id == 1 || result.tile_id == 2);
        }
        // リセットが機能している: どのタイルの usage も cap(1)+α を超えない
        for id in [1_u64, 2] {
            assert!(
                pool.feature(id).map_or(false, |f| f.usage <= 1),
                "usage must be capped"
            );
        }
    }

    #[test]
    fn usage_cap_zero_is_unlimited() {
        // usage_cap = 0 は無制限(リセットが行われない)
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let near: [f32; 3] = [50.5, 0.0, 0.0];
        let blocks = uniform_blocks(target, 0.0, 10);
        let config = MosaicConfig {
            usage_cap: 0,
            ..MosaicConfig::default()
        };
        let mut pool = pool_with_tiles(&[(near, 0.0, 1)]);
        let results = match_blocks(&blocks, 1, &mut pool, &config);
        assert_eq!(results.len(), 10);
        // usage は加算が続く(usage も all_usage_reached は常に false)
        assert!(pool.feature(1).map_or(false, |f| f.usage >= 10));
    }

    #[test]
    fn identical_candidates_prefer_higher_detail() {
        // ΔE76 < identical_de(視覚上同一)の候補が複数 → detail 大が優先される
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let flat: [f32; 3] = [50.5, 0.0, 0.0];
        let blocks = uniform_blocks(target, 10.0, 1);
        let config = MosaicConfig::default();

        // 前者 detail 0、後者 detail 30(同一色)→ textured が選ばれる
        let mut pool = pool_with_tiles(&[(flat, 0.0, 1), (flat, 30.0, 2)]);
        let results = match_blocks(&blocks, 1, &mut pool, &config);
        assert_eq!(
            results[0].tile_id, 2,
            "textured tile must win when identical"
        );
    }

    #[test]
    fn distance_dominates_beyond_identical_threshold() {
        // 視覚上同一でない候補(ΔE76 >= identical_de)は距離最小が優先される
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let near_flat: [f32; 3] = [52.5, 0.0, 0.0]; // ΔE76 = 2.5(detail 0)
        let textured: [f32; 3] = [52.6, 0.0, 0.0]; // ΔE76 = 2.6(detail 100)
        let blocks = uniform_blocks(target, 0.0, 1);
        let config = MosaicConfig::default();

        let mut pool = pool_with_tiles(&[(textured, 100.0, 1), (near_flat, 0.0, 2)]);
        let results = match_blocks(&blocks, 1, &mut pool, &config);
        assert_eq!(
            results[0].tile_id, 2,
            "distance must dominate beyond identical_de"
        );
    }

    #[test]
    fn neighbor_penalty_flips_next_choice() {
        // 直上と同一タイルには n_p が加算される → 近い他タイルが逆転して選ばれる
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let same: [f32; 3] = [50.0, 0.0, 0.0]; // ΔE76 = 0
        let other: [f32; 3] = [50.4, 0.0, 0.0]; // ΔE76 = 0.4
        let blocks = uniform_blocks(target, 0.0, 2);
        let config = MosaicConfig::default();

        let mut pool = pool_with_tiles(&[(other, 0.0, 1), (same, 0.0, 2)]);
        let results = match_blocks(&blocks, 1, &mut pool, &config);
        // ブロック 0: 同色 same(detail 同点 → 距離同点 → 先着は ID 昇順走査で same の方が
        //   距離最小)… 2 枚とも ΔE0/0.4 < identical_de、detail 同点 → 距離最小の same
        assert_eq!(results[0].tile_id, 2);
        // ブロック 1(直上 = same): D(same) = 0 + n_p(0.5) = 0.5 > D(other) = 0.4
        assert_eq!(
            results[1].tile_id, 1,
            "neighbor penalty must flip the choice"
        );
    }

    #[test]
    fn left_neighbor_penalty_applies_within_row() {
        // 直左(同一行の前のブロック)にもペナルティが効く: cols=2 の 1 行
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let same: [f32; 3] = [50.0, 0.0, 0.0];
        let other: [f32; 3] = [50.4, 0.0, 0.0];
        let blocks = uniform_blocks(target, 0.0, 2);
        let config = MosaicConfig::default();

        let mut pool = pool_with_tiles(&[(other, 0.0, 1), (same, 0.0, 2)]);
        let results = match_blocks(&blocks, 2, &mut pool, &config);
        assert_eq!(results[0].tile_id, 2);
        // ブロック 1 の直左は same(指定上、直上は存在しない)→ other が選ばれる
        assert_eq!(results[1].tile_id, 1);
    }

    #[test]
    fn empty_pool_returns_empty_results() {
        let blocks = uniform_blocks([50.0, 0.0, 0.0], 0.0, 3);
        let mut pool = TilePool::new();
        let config = MosaicConfig::default();
        let results = match_blocks(&blocks, 4, &mut pool, &config);
        assert!(results.is_empty());
    }

    #[test]
    fn match_results_are_deterministic() {
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let tiles = [([51.0, 0.0, 0.0], 5.0, 1), ([53.0, 2.0, 1.0], 3.0, 2)];
        let blocks = uniform_blocks(target, 4.0, 8);
        let config = MosaicConfig::default();

        let a = {
            let mut pool = pool_with_tiles(&tiles);
            match_blocks(&blocks, 4, &mut pool, &config)
        };
        let b = {
            let mut pool = pool_with_tiles(&tiles);
            match_blocks(&blocks, 4, &mut pool, &config)
        };
        assert_eq!(a, b);
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

    /// ゴールデン検証(詳細設計書 11 章): 固定入力 → 決定的出力をハッシュ比較する
    #[test]
    fn golden_hash_of_fixed_input() {
        let blocks = vec![
            block([50.0, 2.0, -2.0], 4.0, 0),
            block([75.0, -4.0, 6.0], 8.0, 1),
            block([25.0, 8.0, 4.0], 2.0, 2),
            block([90.0, -8.0, -6.0], 12.0, 3),
        ];
        let tiles = [
            ([51.0, 3.0, -1.0], 5.0, 1),
            ([74.0, -3.0, 7.0], 9.0, 2),
            ([26.0, 9.0, 5.0], 1.0, 3),
            ([91.0, -7.0, -5.0], 11.0, 4),
        ];
        let config = MosaicConfig::default();

        let mut pool = pool_with_tiles(&tiles);
        let results = match_blocks(&blocks, 2, &mut pool, &config);

        let mut bytes = Vec::new();
        for result in &results {
            bytes.extend_from_slice(&result.block_index.to_le_bytes());
            bytes.extend_from_slice(&result.tile_id.to_le_bytes());
        }
        assert_eq!(
            fnv1a64(&bytes),
            0xCE18_7139_92FF_0EA1,
            "golden hash mismatch: inspect intentional spec changes and update this value"
        );
    }
}
