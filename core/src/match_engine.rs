//! マッチング(P3: 詳細設計書 4.4)。
//!
//! - 各ブロックに対し、タイルプールから距離最小のタイルを選ぶ
//!   `D = w_c * ΔE76 + w_d * |detail差| + λ * usage + n_p * neighbor_same`
//! - 使用ペナルティの λ でタイル群を均等に散らばらせ、全タイルの使用回数が
//!   usage_cap に達したら一括リセットする(スタック防止)
//! - **重複グループ**(詳細設計書 4.4): 類似タイル(同一写真の複製・至近
//!   バースト)は `duplicate_de` / `duplicate_detail` の閾値内で同一視され、
//!   `usage` はグループ合計、`neighbor_same` は同一グループ判定、usage_cap の
//!   リセット判定はグループ合計基準になる(見た目上同じ写真が並んで
//!   使われるのを防ぐ)。重複がなければ全判定がタイル単位と一致する
//! - ΔE76 < identical_de(視覚上ほぼ同一)の候補が複数ある場合は
//!   detail が大きい方(情報量が多い方)を優先する
//! - 走査順は「ブロック番号昇順 × タイル ID 昇順」に固定し、同一入力に対して
//!   決定的な結果を保証する(handoff/02 4 章の決定性指針)
//! - 割当表は全ブロック分の `Option<u64>`(None = 未確定ブロック)とし、
//!   フルマッチと差分再マッチ(M6: 未確定のみマッチ / 差し替え評価)を
//!   単一の実装で扱う

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
/// 未確定のみの割当表へ [`match_unmatched_range`] を適用した結果と同一
/// (フルランと差分再マッチが単一の実装を共有する)。
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
    let mut assigned: Vec<Option<u64>> = vec![None; blocks.len()];
    match_unmatched_range(blocks, cols, pool, config, &mut assigned, 0, blocks.len());
    assignments_to_matches(&assigned)
}

/// 割当表からマッチ結果を組み立てる(未確定ブロックは除外)。
///
/// ブロック番号は割当表上の位置(= BlockFeature.index)と一致する
pub fn assignments_to_matches(assigned: &[Option<u64>]) -> Vec<MatchResult> {
    assigned
        .iter()
        .enumerate()
        .filter_map(|(i, tile_id)| {
            tile_id.map(|tile_id| MatchResult {
                block_index: u32::try_from(i).expect("block index fits u32"),
                tile_id,
            })
        })
        .collect()
}

/// ブロック範囲 `[block_begin, block_end)` のうち未確定(None)のブロックを
/// マッチする(P3 の行バッチ実行)。
///
/// - `assigned` は全ブロック長の割当表(長さは `blocks.len()` と一致させること)。
///   選択結果を in-place で書き込み、確定済みブロックは変更せず
///   隣接参照(直上・直左)に利用する。M6 の差分再マッチでは既存割当との
///   混在走査になる(フルランは全要素 None の初期表で呼び出す)
/// - 走査順は「ブロック番号昇順 × タイル ID 昇順」に固定し、同一入力に対して
///   決定的な結果を保証する(handoff/02 4 章の決定性指針)
/// - 返り値は本呼び出しでマッチしたブロック位置(昇順。位置 = block_index)
/// - タイルプールが空・`cols == 0`・割当表の長さ不一致の場合は空の結果を返す
pub fn match_unmatched_range(
    blocks: &[BlockFeature],
    cols: u32,
    pool: &mut TilePool,
    config: &MosaicConfig,
    assigned: &mut [Option<u64>],
    block_begin: usize,
    block_end: usize,
) -> Vec<u32> {
    let mut matched: Vec<u32> = Vec::new();
    if pool.tile_count() == 0 || cols == 0 || assigned.len() != blocks.len() {
        return matched;
    }
    let block_begin = block_begin.min(block_end.min(blocks.len()));
    let block_end = block_end.min(blocks.len());
    // 重複グループを構築済みにする(遅延。プール変更・閾値変更で再構築。
    // 以後の usage・隣接判定はグループ基準になる。詳細設計書 4.4)
    pool.ensure_groups(config.duplicate_de, config.duplicate_detail);

    for (i, block) in blocks.iter().enumerate().take(block_end).skip(block_begin) {
        if assigned[i].is_some() {
            continue; // 確定済み(差分再マッチでは既存割当として隣接参照に使うのみ)
        }

        // 全タイルの使用回数が usage_cap に達したら一括リセット(スタック防止)
        if pool.all_usage_reached(config.usage_cap) {
            pool.reset_usage();
        }

        let block_index = u32::try_from(i).expect("block index fits u32");
        let col = block_index % cols;
        let left_id = if col > 0 { assigned[i - 1] } else { None };
        let above_id = if i >= cols as usize {
            assigned[i - cols as usize]
        } else {
            None
        };

        // 各タイルの距離を評価し最小を選ぶ(ID 昇順走査 → 決定的)。
        // あわせて「視覚上同一(ΔE76 < identical_de)」の候補の中で detail 最大の
        // タイルを追跡し、存在すれば距離最小より優先して選ぶ。
        // TileFeature は Copy のため値で保持し、プールの可変借用と衝突させない。
        // 大量タイル(M7)では総当たりの代わりに k-d 木の近傍上位 32 件を候補と
        // する(usage・隣接ペナルティは候補取得後の再評価で反映する)
        let mut candidate_ids = pool.candidates_for(block, config);
        if candidate_ids.is_empty() {
            candidate_ids = pool.features().map(|f| f.id).collect();
        }
        let mut best: Option<(f32, TileFeature)> = None;
        let mut near_best: Option<(f32, TileFeature)> = None;

        for tile in pool.features_for(&candidate_ids) {
            let de = delta_e76(&block.mean_lab, &tile.mean_lab);
            // 隣接ペナルティは「同一グループ」判定(同一視された複製が直上・直左に
            // あっても加算する。詳細設計書 4.4)
            let neighbor_same = left_id.is_some_and(|l| pool.same_group(l, tile.id))
                || above_id.is_some_and(|a| pool.same_group(a, tile.id));
            // 使用ペナルティはグループ合計の使用回数で評価する(4.4)
            let d = distance(
                block,
                &tile,
                pool.effective_usage(tile.id),
                neighbor_same,
                config,
            );

            if best.is_none_or(|(best_d, _)| d < best_d) {
                best = Some((d, tile));
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
                    near_best = Some((d, tile));
                }
            }
        }

        let chosen_tile = near_best.or(best).expect("pool is non-empty").1;
        pool.bump_usage(chosen_tile.id);
        assigned[i] = Some(chosen_tile.id);
        matched.push(block_index);
    }

    matched
}

/// ブロック範囲 `[block_begin, block_end)` に対し差し替え評価を行う
/// (詳細設計書 4.4 差分再マッチ: タイル追加時・全ブロック確定済みの場合)。
///
/// - 各ブロックについて現割当の距離と全タイル(追加タイルを含む)の最小距離を
///   再計算し、現割当より `improve_margin`(ΔE 換算)以上良い候補がある場合に
///   差し替える(使用回数・隣接ペナルティは再評価する)
/// - 差し替えは走査に逐次反映する(以降のブロックの評価に usage の変化が波及する。
///   走査順はブロック番号昇順で決定的)
/// - 返り値は差し替えたブロック位置(昇順。位置 = block_index)
pub fn evaluate_swap_range(
    blocks: &[BlockFeature],
    cols: u32,
    pool: &mut TilePool,
    config: &MosaicConfig,
    assigned: &mut [Option<u64>],
    block_begin: usize,
    block_end: usize,
) -> Vec<u32> {
    let mut swapped: Vec<u32> = Vec::new();
    if pool.tile_count() == 0 || cols == 0 || assigned.len() != blocks.len() {
        return swapped;
    }
    let block_begin = block_begin.min(block_end.min(blocks.len()));
    let block_end = block_end.min(blocks.len());
    // 重複グループを構築済みにする(遅延。詳細設計書 4.4。match と同一の基準)
    pool.ensure_groups(config.duplicate_de, config.duplicate_detail);

    for (i, block) in blocks.iter().enumerate().take(block_end).skip(block_begin) {
        let Some(current_id) = assigned[i] else {
            continue; // 未確定ブロックは対象外(match_unmatched_range で埋める)
        };
        let Some(current_tile) = pool.feature(current_id) else {
            continue; // 削除済みタイルの割当(防御。未確定化して fill 再マッチする)
        };
        let current_tile = *current_tile; // Copy(プール走査と借用を衝突させない)

        let block_index = u32::try_from(i).expect("block index fits u32");
        let col = block_index % cols;
        let left_id = if col > 0 { assigned[i - 1] } else { None };
        let above_id = if i >= cols as usize {
            assigned[i - cols as usize]
        } else {
            None
        };
        // 隣接・使用ペナルティは重複グループ基準で再評価する(詳細設計書 4.4)
        let neighbor_current = left_id.is_some_and(|l| pool.same_group(l, current_id))
            || above_id.is_some_and(|a| pool.same_group(a, current_id));
        let current_d = distance(
            block,
            &current_tile,
            pool.effective_usage(current_id),
            neighbor_current,
            config,
        );

        // 全タイル(ID 昇順走査)の距離を再評価し最小を選ぶ。
        // 差し替え評価は improve_margin による純粋な距離比較のみを行う
        // (identical_de による detail 優先は初回マッチの規則)。
        // 大量タイル(M7)では k-d 木候補 + 現割当タイルを評価対象とする
        let mut candidate_ids = pool.candidates_for(block, config);
        if candidate_ids.is_empty() {
            candidate_ids = pool.features().map(|f| f.id).collect();
        } else if !candidate_ids.contains(&current_id) {
            // 差し替え評価の基準となる現割当が候補外に漏れると
            // 改善判定が実際より良くなる(現割当が評価対象外に漏れる)ため必ず含める
            candidate_ids.push(current_id);
            candidate_ids.sort_unstable();
        }
        let mut best: Option<(f32, u64)> = None;
        for tile in pool.features_for(&candidate_ids) {
            // 隣接ペナルティは「同一グループ」判定、使用ペナルティはグループ合計
            // の使用回数で評価する(詳細設計書 4.4)
            let neighbor_same = left_id.is_some_and(|l| pool.same_group(l, tile.id))
                || above_id.is_some_and(|a| pool.same_group(a, tile.id));
            let d = distance(
                block,
                &tile,
                pool.effective_usage(tile.id),
                neighbor_same,
                config,
            );
            if best.is_none_or(|(best_d, _)| d < best_d) {
                best = Some((d, tile.id));
            }
        }
        let Some((best_d, best_id)) = best else {
            continue;
        };

        if best_id != current_id && current_d - best_d >= config.improve_margin {
            assigned[i] = Some(best_id);
            pool.bump_usage(best_id);
            pool.decrease_usage(current_id);
            swapped.push(block_index);
        }
    }

    swapped
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
        // 同色 2 枚(ΔE 0、detail 同点)は重複グループに同一視される(詳細設計書 4.4)。
        // 選択は ID 小に集約され、グループ合計が cap に達した時点で一括リセットされて
        // マッチングが継続する(スタック防止)
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
        // (同一視された 2 枚はグループ合計 1 で cap 到達 → 一括リセット)
        for id in [1_u64, 2] {
            assert!(
                pool.feature(id).is_some_and(|f| f.usage <= 1),
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
        assert!(pool.feature(1).is_some_and(|f| f.usage >= 10));
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
        // 直上と同一タイルには n_p が加算される → 近い他タイルが逆転して選ばれる。
        // 2 枚は duplicate_de より遠い位置関係(直交方向)に置き互いに別グループにする
        // (同一視された複製が隣接するケースは neighbor_penalty_applies_to_duplicate_group)
        let target: [f32; 3] = [53.0, 0.0, 0.0];
        let same: [f32; 3] = [50.6, 0.0, 0.0]; // ΔE76 = 2.4(identical_de・duplicate_de の外)
        let other: [f32; 3] = [53.0, 2.5, 0.0]; // ΔE76 = 2.5(same とは約 3.5 → 別グループ)
        let blocks = uniform_blocks(target, 0.0, 2);
        let config = MosaicConfig::default();

        let mut pool = pool_with_tiles(&[(other, 0.0, 1), (same, 0.0, 2)]);
        let results = match_blocks(&blocks, 1, &mut pool, &config);
        // ブロック 0: same の距離 2.4 が最小(2.5 より近い)
        assert_eq!(results[0].tile_id, 2);
        // ブロック 1(直上 = same): D(same) = 2.4 + 0.35 + 0.5 = 3.25 > D(other) = 2.5
        assert_eq!(
            results[1].tile_id, 1,
            "neighbor penalty must flip the choice"
        );
    }

    #[test]
    fn left_neighbor_penalty_applies_within_row() {
        // 直左(同一行の前のブロック)にもペナルティが効く: cols=2 の 1 行。
        // 2 枚は duplicate_de より遠い位置関係(直交方向)で互いに別グループ
        let target: [f32; 3] = [53.0, 0.0, 0.0];
        let same: [f32; 3] = [50.6, 0.0, 0.0]; // ΔE76 = 2.4
        let other: [f32; 3] = [53.0, 2.5, 0.0]; // ΔE76 = 2.5(same とは別グループ)
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
    fn duplicate_tiles_share_usage_penalty() {
        // 詳細設計書 4.4 重複グループ: 類似タイル(同一視)は使用回数を共有する。
        // A(ΔE 2.8)を使った後は A'(A と 0.2 → 同一グループ)にも使用ペナルティが
        // 乗る。個別 usage なら A' が無ペナルティで選ばれ、見た目上同じ写真が
        // 連続して使われる(本テストの期待値が従来動作との差分になる)
        let target: [f32; 3] = [53.0, 0.0, 0.0];
        let dup_a: [f32; 3] = [50.2, 0.0, 0.0]; // ΔE76 = 2.8
        let dup_b: [f32; 3] = [50.0, 0.0, 0.0]; // ΔE76 = 3.0(A とは 0.2 → 同一グループ)
        let distinct: [f32; 3] = [56.1, 0.0, 0.0]; // ΔE76 = 3.1(A とは 5.9 → 別グループ)
        let blocks = uniform_blocks(target, 0.0, 3);
        let config = MosaicConfig::default();

        let mut pool = pool_with_tiles(&[(dup_a, 0.0, 1), (dup_b, 0.0, 2), (distinct, 0.0, 3)]);
        // 前提: 1 と 2 は同一視、1 と 3 は別グループ
        pool.ensure_groups(config.duplicate_de, config.duplicate_detail);
        assert!(pool.same_group(1, 2));
        assert!(!pool.same_group(1, 3));

        let results = match_blocks(&blocks, 1, &mut pool, &config);
        // ブロック 0: A(2.8)が最小 → A。ブロック 1: A は 2.8 + 0.35(グループ合計 1)、
        // A' は 3.0 + 0.35、distinct は 3.1 → distinct が逆転
        // (個別 usage なら A' 3.0 が選ばれる)。ブロック 2: A と distinct はともに
        // 使用 1 回で距離差がそのまま効き、A(3.15)が選ばれる
        let tile_ids: Vec<u64> = results.iter().map(|r| r.tile_id).collect();
        assert_eq!(
            tile_ids,
            vec![1, 3, 1],
            "duplicate tiles must share the usage penalty"
        );
    }

    #[test]
    fn neighbor_penalty_applies_to_duplicate_group() {
        // 詳細設計書 4.4: 隣接ペナルティは「同一グループ」判定。
        // 直上に A があるとき、A と同一視された A' にも n_p と使用ペナルティが
        // 乗る(個別判定なら A' が無ペナルティで隣に選ばれる)
        let target: [f32; 3] = [53.0, 0.0, 0.0];
        let dup_a: [f32; 3] = [50.0, 0.0, 0.0]; // ΔE76 = 3.0
        let dup_b: [f32; 3] = [49.96, 0.0, 0.0]; // ΔE76 = 3.04(A とは 0.04 → 同一グループ)
        let distinct: [f32; 3] = [56.6, 0.0, 0.0]; // ΔE76 = 3.6(A とは 6.6 → 別グループ)
        let blocks = uniform_blocks(target, 0.0, 2);
        let config = MosaicConfig::default();

        let mut pool = pool_with_tiles(&[(dup_b, 0.0, 1), (dup_a, 0.0, 2), (distinct, 0.0, 3)]);
        let results = match_blocks(&blocks, 1, &mut pool, &config);
        // ブロック 0: A(3.0)が最小 → A
        assert_eq!(results[0].tile_id, 2);
        // ブロック 1(直上 = A): D(A') = 3.04 + 0.35(グループ合計 1)+ 0.5(同一
        // グループの隣接)= 3.89 > D(distinct) = 3.6 → distinct が選ばれる
        assert_eq!(
            results[1].tile_id, 3,
            "neighbor penalty must apply to duplicates of the adjacent tile"
        );
    }

    #[test]
    fn match_unmatched_range_full_range_equals_match_blocks() {
        let target: [f32; 3] = [50.0, 1.0, 2.0];
        let tiles = [
            ([51.0, 1.0, 2.0], 3.0, 1),
            ([52.0, -1.0, 3.0], 4.0, 2),
            ([53.0, 2.0, -2.0], 5.0, 3),
        ];
        let blocks = uniform_blocks(target, 4.0, 12);
        let config = MosaicConfig::default();

        let whole = {
            let mut pool = pool_with_tiles(&tiles);
            match_blocks(&blocks, 4, &mut pool, &config)
        };
        let ranged = {
            let mut pool = pool_with_tiles(&tiles);
            let mut assigned: Vec<Option<u64>> = vec![None; blocks.len()];
            match_unmatched_range(
                &blocks,
                4,
                &mut pool,
                &config,
                &mut assigned,
                0,
                blocks.len(),
            );
            assignments_to_matches(&assigned)
        };
        assert_eq!(whole, ranged);
        assert_eq!(ranged.len(), blocks.len());
        for (i, result) in ranged.iter().enumerate() {
            assert_eq!(result.block_index, i as u32);
        }
    }

    #[test]
    fn match_unmatched_range_skips_already_assigned_blocks() {
        // 差分再マッチ(M6): 確定済みブロックは変更せず、未確定のみ埋める。
        // cols=4 / 4 行 = 16 ブロックのうちブロック 5〜10 を事前確定しておく
        let target: [f32; 3] = [50.0, 0.5, -0.5];
        let tiles = [([50.5, 0.0, 0.0], 1.0, 1), ([50.0, 1.0, -1.0], 0.5, 2)];
        let blocks = uniform_blocks(target, 2.0, 16);
        let config = MosaicConfig::default();

        let mut assigned: Vec<Option<u64>> = (0..16_u64).map(|i| Some(i + 100)).collect();
        let mut pool = pool_with_tiles(&tiles);
        let matched = match_unmatched_range(&blocks, 4, &mut pool, &config, &mut assigned, 0, 16);
        // 事前確定分(100..116)は変更されず、未確定ブロックは存在しない
        assert!(matched.is_empty());
        assert!(assigned.iter().all(Option::is_some));
        assert_eq!(assigned[0], Some(100));

        // 半分を未確定に戻して再マッチ: 未確定のみが埋まる
        let mut assigned: Vec<Option<u64>> = (0..16_u64).map(|i| Some(i + 100)).collect();
        for slot in assigned.iter_mut().skip(5).take(6) {
            *slot = None;
        }
        let matched = match_unmatched_range(&blocks, 4, &mut pool, &config, &mut assigned, 0, 16);
        assert_eq!(matched, vec![5, 6, 7, 8, 9, 10], "only unmatched positions");
        for (i, slot) in assigned.iter().enumerate() {
            if (5..11).contains(&i) {
                assert!(slot.is_some(), "block {i} must be matched");
            } else {
                assert_eq!(*slot, Some(i as u64 + 100), "block {i} must be kept");
            }
        }
    }

    #[test]
    fn match_unmatched_range_resumes_with_neighbor_history() {
        // 行バッチ化(M5)+ 差分再マッチ(M6): 全体一括と「行ごとの分割」が
        // 同一結果になること。cols=4 / 4 行 = 16 ブロックを 1 行ずつ(4 回)に分ける
        let target: [f32; 3] = [50.0, 0.5, -0.5];
        let tiles = [
            ([50.5, 0.0, 0.0], 1.0, 1),
            ([50.0, 1.0, -1.0], 0.5, 2),
            ([51.5, -2.0, 2.0], 2.0, 3),
        ];
        let blocks = uniform_blocks(target, 2.0, 16);
        let cols = 4_u32;
        let config = MosaicConfig::default();

        let whole = {
            let mut pool = pool_with_tiles(&tiles);
            match_blocks(&blocks, cols, &mut pool, &config)
        };
        let mut pool = pool_with_tiles(&tiles);
        let mut assigned: Vec<Option<u64>> = vec![None; blocks.len()];
        let mut pos = 0_usize;
        while pos < blocks.len() {
            let end = (pos + cols as usize).min(blocks.len());
            match_unmatched_range(&blocks, cols, &mut pool, &config, &mut assigned, pos, end);
            pos = end;
        }
        let batched = assignments_to_matches(&assigned);
        assert_eq!(whole, batched, "row batch must not change match results");
    }

    #[test]
    fn match_unmatched_range_out_of_bounds_is_clamped() {
        let blocks = uniform_blocks([50.0, 0.0, 0.0], 0.0, 4);
        let mut pool = pool_with_tiles(&[([50.5, 0.0, 0.0], 0.0, 1)]);
        let config = MosaicConfig::default();
        // 範囲が窓外(開始 > 終了、block_end > 全体)でも安全にクランプされる
        let mut assigned: Vec<Option<u64>> = vec![None; 4];
        let results = match_unmatched_range(&blocks, 2, &mut pool, &config, &mut assigned, 4, 10);
        assert!(results.is_empty());
        let mut assigned: Vec<Option<u64>> = vec![None; 4];
        let results = match_unmatched_range(&blocks, 2, &mut pool, &config, &mut assigned, 0, 100);
        assert_eq!(results.len(), 4);
        assert!(assigned.iter().all(Option::is_some));
        // 割当表の長さ不一致も安全に空を返す(呼び出し側の取り違え検知)
        let mut assigned: Vec<Option<u64>> = vec![None; 3];
        let results = match_unmatched_range(&blocks, 2, &mut pool, &config, &mut assigned, 0, 4);
        assert!(results.is_empty());
    }

    #[test]
    fn evaluate_swap_only_beyond_improve_margin() {
        // 差し替え評価(詳細設計書 4.4): 現割当より improve_margin 以上良い
        // 候補がある場合のみ差し替える。使用回数・隣接ペナルティは再評価する。
        // タイル 1〜3 は互いに duplicate_de 外の位置関係(別グループ)に置き、
        // 現割当 1(ブロック 0)と 3(ブロック 1)は異なる色で隣接の影響を排除する
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let blocks = uniform_blocks(target, 0.0, 2);
        let current_a: [f32; 3] = [51.5, 0.0, 0.0]; // ΔE76 = 1.5(タイル 1)
        let better: [f32; 3] = [49.0, 0.0, 0.0]; // ΔE76 = 1.0(タイル 2。1 とは 2.5 → 別グループ)
        let current_b: [f32; 3] = [50.0, 1.9, 0.0]; // ΔE76 = 1.9(タイル 3。1/2 とは別グループ)

        // マージン 1.0(既定)→ 改善 0.5(ブロック 0)/ 0.9(ブロック 1)では現状維持
        {
            let mut pool =
                pool_with_tiles(&[(current_a, 0.0, 1), (better, 0.0, 2), (current_b, 0.0, 3)]);
            let mut assigned = vec![Some(1_u64), Some(3_u64)];
            let config = MosaicConfig::default();
            let swapped = evaluate_swap_range(&blocks, 2, &mut pool, &config, &mut assigned, 0, 2);
            assert!(swapped.is_empty(), "improvement below margin must keep");
            assert_eq!(assigned, vec![Some(1), Some(3)]);
            assert_eq!(pool.feature(2).expect("tile 2").usage, 0);
        }
        // マージン 0.5 → 改善 0.5 のブロック 0 だけ差し替わる。
        // ブロック 1 は差し替え後のタイル 2 が直左になり隣接ペナルティ +
        // 使用ペナルティ(usage 1)で有利にならず現状維持(改善 0.4 < 0.5)。
        // (使用回数・隣接ペナルティの再評価)
        {
            let mut pool =
                pool_with_tiles(&[(current_a, 0.0, 1), (better, 0.0, 2), (current_b, 0.0, 3)]);
            let mut assigned = vec![Some(1_u64), Some(3_u64)];
            let config = MosaicConfig {
                improve_margin: 0.5,
                ..MosaicConfig::default()
            };
            let swapped = evaluate_swap_range(&blocks, 2, &mut pool, &config, &mut assigned, 0, 2);
            assert_eq!(swapped, vec![0], "only block 0 exceeds the margin");
            assert_eq!(assigned, vec![Some(2), Some(3)]);
            // 使用回数の再評価: 差し替えで old が減り new が増える
            assert_eq!(pool.feature(1).expect("tile 1").usage, 0);
            assert_eq!(pool.feature(2).expect("tile 2").usage, 1);
            assert_eq!(pool.feature(3).expect("tile 3").usage, 0);
        }
    }

    #[test]
    fn evaluate_swap_updates_usage_for_subsequent_blocks() {
        // 差し替え評価は使用ペナルティを再評価する: 候補タイル 2 は距離最小
        // (ΔE 1.0)だが usage 3 → D = 1.0 + 1.05 = 2.05。現割当 1(ΔE 1.5、
        // usage 0 → D = 1.5)が維持される(改善なし)。ブロック 1 でも直上の
        // 割当(タイル 1)が両者へ与える隣接ペナルティの差で現状維持になる。
        // タイル 1/2 は duplicate_de 外(別グループ)の位置関係に置く
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let near: [f32; 3] = [49.0, 0.0, 0.0]; // ΔE76 = 1.0(タイル 2)
        let other: [f32; 3] = [51.5, 0.0, 0.0]; // ΔE76 = 1.5(タイル 1。2 とは 2.5 → 別グループ)
        let blocks = uniform_blocks(target, 0.0, 2);
        let mut pool = pool_with_tiles(&[(other, 0.0, 1), (near, 0.0, 2)]);
        for _ in 0..3 {
            pool.bump_usage(2);
        }
        let config = MosaicConfig {
            improve_margin: 0.5,
            ..MosaicConfig::default()
        };
        // ブロック 0: 現割当 1 の D = 1.5 < 候補 2 の D = 2.05 → 維持。
        // ブロック 1: 直上 = 1 → D(1) = 1.5 + 0.5 = 2.0 < D(2) = 2.05(隣接なし)→ 維持
        let mut assigned = vec![Some(1_u64), Some(1_u64)];
        let swapped = evaluate_swap_range(&blocks, 1, &mut pool, &config, &mut assigned, 0, 2);
        assert!(swapped.is_empty());
        assert_eq!(assigned, vec![Some(1), Some(1)]);
    }

    #[test]
    fn evaluate_swap_skips_unassigned_blocks() {
        // 未確定ブロック(None)は差し替え評価の対象外(match で埋める)
        let target: [f32; 3] = [50.0, 0.0, 0.0];
        let near: [f32; 3] = [50.0, 0.0, 0.0];
        let blocks = uniform_blocks(target, 0.0, 2);
        let mut pool = pool_with_tiles(&[(near, 0.0, 1), ([49.0, 0.0, 0.0], 0.0, 2)]);
        let mut assigned = vec![None, Some(1_u64)];
        let config = MosaicConfig::default();
        let swapped = evaluate_swap_range(&blocks, 1, &mut pool, &config, &mut assigned, 0, 2);
        assert!(swapped.is_empty(), "None block must be skipped");
        assert_eq!(assigned[0], None);
        assert_eq!(assigned[1], Some(1));
    }

    #[test]
    fn kd_tree_candidates_below_query_k_match_brute_force() {
        // M7: 閾値をテスト用に下げて k-d 木経路を強制し、総当たりと同一結果に
        // なることを確認する(候補数 4 ≤ k=32 なので近似誤差はない)
        let target: [f32; 3] = [50.0, 0.5, -0.5];
        let tiles = [
            ([50.5, 0.0, 0.0], 1.0, 1),
            ([50.0, 1.0, -1.0], 0.5, 2),
            ([51.5, -2.0, 2.0], 2.0, 3),
            ([48.0, 3.0, 3.0], 0.0, 4),
        ];
        let blocks = uniform_blocks(target, 2.0, 8);
        let config = MosaicConfig::default();

        let brute = {
            let mut pool = pool_with_tiles(&tiles);
            assert!(!pool.uses_kd_index());
            match_blocks(&blocks, 4, &mut pool, &config)
        };
        let via_kd = {
            let mut pool = pool_with_tiles(&tiles);
            pool.set_kd_threshold_for_test(2);
            assert!(pool.uses_kd_index());
            let results = match_blocks(&blocks, 4, &mut pool, &config);
            // 構築統計が記録されている(p2_index_build スパンの計測点)
            assert!(pool.index_build_stats().count >= 1);
            results
        };
        assert_eq!(
            brute, via_kd,
            "k-d candidates must not change results when k >= tile count"
        );
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
