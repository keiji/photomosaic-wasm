//! フェーズ制御・オーケストレーション(詳細設計書 4.1)。
//!
//! M4: P3(マッチング)+ P4(合成)の直列一括実行。
//! M5 で行バッチごとの JS 制御返し・進捗イベント(`onProgress` / `onResult`)・
//! キャンセル(`cancel()`)・要求合流(詳細設計書 7.5)に拡張する。

use crate::compose;
use crate::config::MosaicConfig;
use crate::grid::{BlockFeature, GridInfo};
use crate::match_engine::{self, MatchResult};
use crate::tile::TilePool;

/// 1 回の run の出力(P3 + P4)
#[derive(Clone, Debug, PartialEq)]
pub struct RunOutput {
    /// マッチ結果(ブロック番号昇順)
    pub matches: Vec<MatchResult>,
    /// 合成結果(メイン画像と同寸法の RGBA。アルファは 255)
    pub rgba: Vec<u8>,
}

/// P3 + P4 を直列に一括実行する(M4 のフォトモザイク一括生成)。
///
/// - `grid` / `block_features`: P1 の出力(メイン画像のグリッド・ブロック特徴量)
/// - `pool`: P2 で解析済みのタイルプール(使用回数の更新を受け持つ)
/// - 空のプールでの run は呼び出し側(UI 層)が案内するため、本関数は
///   プールが空でもマッチ・合成とも空の結果を返さず `Result` で中断する
pub fn run_phases(
    grid: &GridInfo,
    block_features: &[BlockFeature],
    pool: &mut TilePool,
    config: &MosaicConfig,
) -> Result<RunOutput, String> {
    if pool.tile_count() == 0 {
        return Err("tile pool is empty".to_string());
    }

    // M4 では初回マッチングに備えて使用回数を正規化する
    // (M6 の差分再マッチでは現割当表からの再集計に置き換わる)
    pool.reset_usage();

    // P3 マッチング
    let matches = match_engine::match_blocks(block_features, grid.cols, pool, config);

    // P4 合成
    let assignments: Vec<u64> = matches.iter().map(|m| m.tile_id).collect();
    let rgba = compose::compose(grid, block_features, &assignments, pool, config);

    Ok(RunOutput { matches, rgba })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tile::FEATURE_THUMB;

    /// 決定的なテスト画像(x/y の線形組合せ。乱数シードなし)
    fn test_image(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                rgba.extend_from_slice(&[
                    ((x * 7 + y * 13) % 256) as u8,
                    ((x * 5 + y * 11 + 64) % 256) as u8,
                    ((x * 3 + y * 17 + 128) % 256) as u8,
                    255,
                ]);
            }
        }
        rgba
    }

    fn setup_pool(tile_count: u64) -> TilePool {
        let mut pool = TilePool::new();
        for tile_id in 1..=tile_count {
            let mut feature_arg = vec![0_u8; FEATURE_THUMB as usize * FEATURE_THUMB as usize * 4];
            let size = 64_usize;
            let mut compose_arg = vec![0_u8; size * size * 4];
            for (i, pixel) in feature_arg.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                pixel[0] = ((i * 3) % 256) as u8;
                pixel[1] = ((i * 5 + tile_id as usize * 7) % 256) as u8;
                pixel[2] = ((i * 11 + tile_id as usize * 13) % 256) as u8;
                pixel[3] = 255;
            }
            for (i, pixel) in compose_arg.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                pixel[0] = ((i * 7 + tile_id as usize * 17) % 256) as u8;
                pixel[1] = ((i * 13 + tile_id as usize * 19) % 256) as u8;
                pixel[2] = ((i * 23 + tile_id as usize * 29) % 256) as u8;
                pixel[3] = 255;
            }
            pool.add_tile(tile_id, &feature_arg, &compose_arg, 64, 64)
                .expect("tile registration should succeed");
        }
        pool
    }

    #[test]
    fn run_phases_produces_full_size_output() {
        // メイン 96x48 / block 24 → 4x2 = 8 ブロック
        let rgba = test_image(96, 48);
        let grid = crate::grid::compute_grid_info(96, 48, 24);
        let features = crate::grid::compute_block_features(&rgba, 96, 48, 24);
        let mut pool = setup_pool(4);
        let config = MosaicConfig::default();

        let output = run_phases(&grid, &features, &mut pool, &config).expect("run should succeed");
        assert_eq!(output.matches.len(), 8);
        assert_eq!(output.rgba.len(), 96 * 48 * 4);
        // 出力は全ピクセル不透明
        assert!(output.rgba.as_chunks::<4>().0.iter().all(|px| px[3] == 255));
        // マッチ結果はブロック番号昇順
        for (i, m) in output.matches.iter().enumerate() {
            assert_eq!(m.block_index, i as u32);
        }
        // 使用回数が記録される
        let total_usage: u32 = pool.features().map(|f| f.usage).sum();
        assert_eq!(total_usage, 8);
    }

    #[test]
    fn run_phases_is_deterministic() {
        let rgba = test_image(96, 48);
        let grid = crate::grid::compute_grid_info(96, 48, 24);
        let features = crate::grid::compute_block_features(&rgba, 96, 48, 24);
        let config = MosaicConfig::default();

        let a = {
            let mut pool = setup_pool(4);
            run_phases(&grid, &features, &mut pool, &config).expect("run should succeed")
        };
        let b = {
            let mut pool = setup_pool(4);
            run_phases(&grid, &features, &mut pool, &config).expect("run should succeed")
        };
        assert_eq!(a, b);
    }

    #[test]
    fn run_phases_rejects_empty_pool() {
        let rgba = test_image(24, 24);
        let grid = crate::grid::compute_grid_info(24, 24, 24);
        let features = crate::grid::compute_block_features(&rgba, 24, 24, 24);
        let mut pool = TilePool::new();
        let config = MosaicConfig::default();
        let err = run_phases(&grid, &features, &mut pool, &config).expect_err("empty pool");
        assert_eq!(err, "tile pool is empty");
    }

    #[test]
    fn run_phases_matches_pipeline_budget() {
        // 完了条件(handoff/04 M4): 代表的な小サイズで目視破綻しない仕上がりに加え、
        // 一括生成が性能上限を超えないことを緩いリグレッション基準として確認する。
        // S-mid 相当(4000x3000 / 300 枚)は CI 環境で重く、ここでは縮小条件での
        // 相当量(50 枚タイル / 1600x1200 / block 24 ≒ S-small)で検証する
        let rgba = test_image(1600, 1200);
        let grid = crate::grid::compute_grid_info(1600, 1200, 24);
        let features = crate::grid::compute_block_features(&rgba, 1600, 1200, 24);
        let mut pool = setup_pool(50);
        let config = MosaicConfig::default();

        let start = std::time::Instant::now();
        let output = run_phases(&grid, &features, &mut pool, &config).expect("run should succeed");
        let elapsed = start.elapsed();
        assert_eq!(output.rgba.len(), 1600 * 1200 * 4);
        // P3 目標(300 枚・12MP で 1,000ms)の換算ではなく、S-small での緩い
        // 上限(2 秒)でリグレッション検知とする
        assert!(
            elapsed.as_millis() < 2_000,
            "full pipeline took {elapsed:?}, budget is 2,000ms"
        );
    }
}
