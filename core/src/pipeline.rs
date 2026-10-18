//! フェーズ制御・オーケストレーション(詳細設計書 4.1 / 7 章 / 8.1)。
//!
//! M5: P3(マッチング)と P4(合成)を行バッチ単位で進める
//! [`BatchRunState`] を提供する。
//!
//! - `step()` の 1 呼び出しが 1 行バッチ(row_batch 行)ぶんの処理に対応し、
//!   進捗イベント([`ProgressEvent`])と部分結果([`ResultBatch`])を返す
//! - ホスト(Web / Android の JS 環境)はバッチ境界で JS へ制御を返し、
//!   UI 更新に譲ったうえで次のバッチを再開する(詳細設計書 8.1)
//! - キャンセルは次のバッチ境界で効果を発揮する(詳細設計書 7.5)。
//!   キャンセル済みでも、既存のマッチ結果と現時点までの合成結果は保持される

use crate::compose;
use crate::config::MosaicConfig;
use crate::grid::{BlockFeature, GridInfo};
use crate::match_engine::{match_block_range, MatchResult};
use crate::progress::{Phase, PhasePlan, ProgressEvent, ProgressThrottle};
use crate::tile::TilePool;

/// 1 回の run の出力(P3 + P4)
#[derive(Clone, Debug, PartialEq)]
pub struct RunOutput {
    /// マッチ結果(ブロック番号昇順)
    pub matches: Vec<MatchResult>,
    /// 合成結果(メイン画像と同寸法の RGBA。アルファは 255)
    pub rgba: Vec<u8>,
}

/// 部分結果(詳細設計書 3 章 ResultBatch / 7.4)。
///
/// P4 合成の行バッチ完了ごとに通知され、UI はその行範囲をプレビューへ
/// 逐次転写する(「メイン画像がフォトモザイクへ置き換わっていく」演出)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultBatch {
    /// 完成した行範囲 `[row_begin, row_end)`(ブロック行)
    pub row_begin: u32,
    pub row_end: u32,
    /// 画像幅 px(行バッファの幅)
    pub width: u32,
    /// 1 行バッチの高さの元となるブロックサイズ px
    /// (1 ブロック行 = block_size 画素行)
    pub block_size: u32,
    /// `width * (row_end - row_begin) * block_size * 4` バイトの
    /// 合成済み RGBA(下端の半端ブロック行は画像端でクリップ)
    pub rgba: Vec<u8>,
}

/// `BatchRunState::step()` 1 バッチ分の結果(onProgress / onResult 相当)
#[derive(Debug, PartialEq)]
pub struct Step {
    /// 発火すべき進捗イベント(onProgress)。スロットリングで抑制された場合は None
    pub progress: Option<ProgressEvent>,
    /// 部分結果(onResult)。P4 合成バッチでのみ Some
    pub result: Option<ResultBatch>,
    /// 以降の step が不要になった(完了またはキャンセル)
    pub done: bool,
}

/// 進行中のフェーズ(run の実行順序は P3 → P4 に固定)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunPhase {
    /// P3 マッチング(matched_rows 行目以降が未確定)
    Matching,
    /// P4 合成(compose_next_row 行目以降が未合成)
    Composing,
}

/// 行バッチで駆動する実行状態(M5: 詳細設計書 4.4 手順 / 7.4 / 8.1)。
///
/// - 内部に P1 出力(グリッド・ブロック特徴量)の実行用スナップショットを持つ
///   (run 中のホスト側変更の影響を受けない)
/// - 出力バッファ `out` の初期値はメイン画像のコピー(行シード)。
///   完了時には全行が合成で上書きされ、キャンセル時には「現時点までの
///   合成結果」として取り出される
pub struct BatchRunState {
    grid: GridInfo,
    /// ブロック特徴量の実行用スナップショット
    features: Vec<BlockFeature>,
    /// 確定済み割当(タイル ID、行優先)。長さ = マッチ済みブロック数
    assigned: Vec<u64>,
    /// P3 進捗: マッチ済み行数
    matched_rows: u32,
    /// P4 進捗: 合成済み行数
    compose_next_row: u32,
    phase: RunPhase,
    /// 全体進捗の配分。run に含まれるのは P3 + P4 のみ(P1/P2 は先行完了のため、
    /// 詳細設計書 7.1 の「スキップされたフェーズの再配分」で正規化する)
    plan: PhasePlan,
    throttle: ProgressThrottle,
    /// 合成結果バッファ(メイン画像コピーで初期化。完成時 / キャンセル時に取り出す)
    out: Vec<u8>,
    canceled: bool,
    done: bool,
}

impl BatchRunState {
    /// 実行状態を生成する(P3 開始前)。
    ///
    /// - `seed_rgba`: メイン画像の RGBA(出力バッファの行シード)。
    ///   長さは `grid.width * grid.height * 4` と一致させる
    pub fn new(grid: GridInfo, block_features: &[BlockFeature], seed_rgba: &[u8]) -> Self {
        let size = to_usize(grid.width) * to_usize(grid.height) * 4;
        assert_eq!(seed_rgba.len(), size, "seed rgba buffer length mismatch");
        BatchRunState {
            grid,
            features: block_features.to_vec(),
            assigned: Vec::with_capacity(to_usize(grid.total_blocks)),
            matched_rows: 0,
            compose_next_row: 0,
            phase: RunPhase::Matching,
            plan: PhasePlan::new(vec![Phase::Match, Phase::Compose]),
            throttle: ProgressThrottle::new(),
            out: seed_rgba.to_vec(),
            canceled: false,
            done: false,
        }
    }

    /// 完了(またはキャンセル)済みか
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// キャンセル済みか(完了時に完走した場合は false)
    pub fn is_canceled(&self) -> bool {
        self.canceled
    }

    /// 現時点までの合成結果を取り出す(完了 / キャンセル後のみ Some)。
    /// 取り出し後は中身が空のバッファになる
    pub fn take_output(&mut self) -> Option<Vec<u8>> {
        if self.done {
            Some(std::mem::take(&mut self.out))
        } else {
            None
        }
    }

    /// キャンセル要求の記録(詳細設計書 7.5)。
    ///
    /// 実行中のバッチは途切れず、次のバッチ境界(次の `step()` 呼び出し)で
    /// 処理を停止する。既存のマッチ結果と現時点までの合成結果
    /// ([`take_output`])は保持される
    pub fn cancel(&mut self) {
        self.canceled = true;
        self.done = true;
    }

    /// 1 行バッチぶん進める(P3 マッチング → P4 合成)。
    ///
    /// - `now_ms` はホストの時刻(起点は不問)。[`ProgressThrottle`] の判定に
    ///   使用する。`None` の場合は進捗イベントを抑制する(時刻を持たない
    ///   一括実行を想定)
    /// - 呼び出し側は戻り値の `done` が `true` になるまで step を繰り返す
    pub fn step(
        &mut self,
        pool: &mut TilePool,
        config: &MosaicConfig,
        now_ms: Option<f64>,
    ) -> Step {
        if self.done {
            return Step {
                progress: None,
                result: None,
                done: true,
            };
        }
        match self.phase {
            RunPhase::Matching => self.step_match(pool, config, now_ms),
            RunPhase::Composing => self.step_compose(pool, config, now_ms),
        }
    }

    /// P3 マッチングの 1 行バッチ
    fn step_match(
        &mut self,
        pool: &mut TilePool,
        config: &MosaicConfig,
        now_ms: Option<f64>,
    ) -> Step {
        if pool.tile_count() == 0 {
            // 一括実行(run_phases)では空プールを呼び出し前に排除する。
            // 防御として、進行しない実行を即時に完了扱いする
            self.done = true;
            return Step {
                progress: None,
                result: None,
                done: true,
            };
        }
        let rows = self.grid.rows;
        let cols = self.grid.cols;
        let batch = config.row_batch.max(1);
        let begin = self.matched_rows;
        let end = begin.saturating_add(batch).min(rows);
        let block_begin = begin.saturating_mul(cols) as usize;
        let block_end = end.saturating_mul(cols) as usize;
        // 確定済み割当は assigned で保持し、隣接参照(直上・直左)に利用する
        match_block_range(
            &self.features,
            cols,
            pool,
            config,
            &mut self.assigned,
            block_begin,
            block_end,
        );
        debug_assert_eq!(
            self.assigned.len(),
            block_end,
            "assigned covers matched blocks"
        );
        self.matched_rows = end;

        let progress = self.emit(
            Phase::Match,
            end as f32 / rows as f32,
            self.matched_rows.saturating_mul(cols),
            now_ms,
            false,
        );
        if end >= rows {
            // P3 完了 → P4 合成へ移行
            self.phase = RunPhase::Composing;
            self.compose_next_row = 0;
        }
        Step {
            progress,
            result: None,
            done: false,
        }
    }

    /// P4 合成の 1 行バッチ。行範囲を合成して部分結果(RGBA)を返す
    fn step_compose(
        &mut self,
        pool: &TilePool,
        config: &MosaicConfig,
        now_ms: Option<f64>,
    ) -> Step {
        let rows = self.grid.rows;
        let batch = config.row_batch.max(1);
        let begin = self.compose_next_row;
        let end = begin.saturating_add(batch).min(rows);
        compose::compose_rows(
            &mut self.out,
            &self.grid,
            &self.features,
            &self.assigned,
            pool,
            config,
            begin,
            end,
        );
        self.compose_next_row = end;

        // 部分結果のスライスは画素行単位(1 ブロック行 = block_size 画素行)。
        // 下端の半端ブロック行は画像端でクリップする(out 長は height 基準)
        let width = to_usize(self.grid.width);
        let block_size = to_usize(self.grid.block_size);
        let slice_begin = (to_usize(begin) * block_size * width * 4).min(self.out.len());
        let slice_end = (to_usize(end) * block_size * width * 4).min(self.out.len());
        let result = Some(ResultBatch {
            row_begin: begin,
            row_end: end,
            width: self.grid.width,
            block_size: self.grid.block_size,
            rgba: self.out[slice_begin..slice_end].to_vec(),
        });

        let final_step = end >= rows;
        // 合成中もブロック進捗バーは 100% を維持する(基本設計書 2.3)。
        // assigned_blocks には全ブロック数を通知する
        let progress = self.emit(
            Phase::Compose,
            end as f32 / rows as f32,
            self.grid.total_blocks,
            now_ms,
            final_step,
        );
        if final_step {
            self.done = true;
        }
        Step {
            progress,
            result,
            done: self.done,
        }
    }

    /// 進捗イベントの発火判定(詳細設計書 7.2)。
    ///
    /// - `force == true` は完了バッチ(最終イベント)で、スロットリングを
    ///   経由せず必ず発火する(最後のバッチで 100% に届かなくなるのを防ぐ)。
    ///   スロットラー状態も起点として更新しておく
    /// - `now_ms == None` かつ非強制の場合は発火しない(一括実行)
    fn emit(
        &mut self,
        phase: Phase,
        phase_ratio: f32,
        assigned_blocks: u32,
        now_ms: Option<f64>,
        force: bool,
    ) -> Option<ProgressEvent> {
        let overall = self.plan.overall_ratio(phase, phase_ratio);
        let fire = force || matches!(now_ms, Some(now) if self.throttle.should_emit(now, overall));
        if force {
            self.throttle.should_emit(now_ms.unwrap_or(0.0), overall);
        }
        if !fire {
            return None;
        }
        Some(ProgressEvent {
            phase,
            phase_ratio,
            overall_ratio: overall,
            assigned_blocks,
            total_blocks: self.grid.total_blocks,
        })
    }
}

/// 確定済み割当(タイル ID 行優先)からマッチ結果を組み立てる
fn to_matches(assigned: &[u64]) -> Vec<MatchResult> {
    assigned
        .iter()
        .enumerate()
        .map(|(i, &tile_id)| MatchResult {
            block_index: i as u32,
            tile_id,
        })
        .collect()
}

/// u32 → usize の変換(wasm32 でも 4 GB 未満の寸法を安全に扱う)
fn to_usize(value: u32) -> usize {
    usize::try_from(value).expect("value fits usize")
}

/// P3 + P4 を一括実行する(同期 API)。
///
/// 内部では [`BatchRunState`] の行バッチ実行を完走させ、一括実行経路と
/// バッチ実行経路が同一の結果になることを保証する(単一の情報源)。
///
/// - `seed_rgba` は出力バッファの行シード(メイン画像。完成時は全行上書きされる)
/// - 空のプールでの run は呼び出し側(UI 層)が案内するため `Err` で中断する
pub fn run_phases(
    grid: &GridInfo,
    block_features: &[BlockFeature],
    pool: &mut TilePool,
    config: &MosaicConfig,
    seed_rgba: &[u8],
) -> Result<RunOutput, String> {
    if pool.tile_count() == 0 {
        return Err("tile pool is empty".to_string());
    }

    // 使用回数を正規化してから開始する(M4 と同一の挙動)
    pool.reset_usage();

    let mut state = BatchRunState::new(*grid, block_features, seed_rgba);
    while !state.is_done() {
        // 一括実行では進捗イベントを返さない(時刻を渡さない)
        if state.step(pool, config, None).done {
            break;
        }
    }
    if state.is_canceled() {
        return Err("canceled".to_string());
    }
    let rgba = state
        .take_output()
        .expect("completed run must produce output");
    let matches = to_matches(&state.assigned);
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

    /// テスト用フィクスチャ: メイン画像・グリッド・ブロック特徴量・既定設定
    struct TestImage {
        grid: GridInfo,
        features: Vec<BlockFeature>,
        rgba: Vec<u8>,
        config: MosaicConfig,
    }

    impl TestImage {
        fn new(width: u32, height: u32, block_size: u32) -> TestImage {
            let rgba = test_image(width, height);
            let grid = crate::grid::compute_grid_info(width, height, block_size);
            let features = crate::grid::compute_block_features(&rgba, width, height, block_size);
            TestImage {
                grid,
                features,
                rgba,
                config: MosaicConfig::default(),
            }
        }
    }

    #[test]
    fn run_phases_produces_full_size_output() {
        // メイン 96x48 / block 24 → 4x2 = 8 ブロック
        let rgba = test_image(96, 48);
        let grid = crate::grid::compute_grid_info(96, 48, 24);
        let features = crate::grid::compute_block_features(&rgba, 96, 48, 24);
        let mut pool = setup_pool(4);
        let config = MosaicConfig::default();

        let output =
            run_phases(&grid, &features, &mut pool, &config, &rgba).expect("run should succeed");
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
            run_phases(&grid, &features, &mut pool, &config, &rgba).expect("run should succeed")
        };
        let b = {
            let mut pool = setup_pool(4);
            run_phases(&grid, &features, &mut pool, &config, &rgba).expect("run should succeed")
        };
        assert_eq!(a, b);
        // 合成が完了しており、シード(メイン画像コピー)がそのまま残っていない
        assert_ne!(a.rgba, rgba);
    }

    #[test]
    fn run_phases_rejects_empty_pool() {
        let rgba = test_image(24, 24);
        let grid = crate::grid::compute_grid_info(24, 24, 24);
        let features = crate::grid::compute_block_features(&rgba, 24, 24, 24);
        let mut pool = TilePool::new();
        let config = MosaicConfig::default();
        let err = run_phases(&grid, &features, &mut pool, &config, &rgba).expect_err("empty pool");
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
        let output =
            run_phases(&grid, &features, &mut pool, &config, &rgba).expect("run should succeed");
        let elapsed = start.elapsed();
        assert_eq!(output.rgba.len(), 1600 * 1200 * 4);
        // P3 目標(300 枚・12MP で 1,000ms)の換算ではなく、S-small での緩い
        // 上限(2 秒)でリグレッション検知とする
        assert!(
            elapsed.as_millis() < 2_000,
            "full pipeline took {elapsed:?}, budget is 2,000ms"
        );
    }

    /// BatchRunState を仮想時刻(now_ms を interval_ms ずつ進める)で完走させ、
    /// 進捗イベントと部分結果を収集する
    fn drive(
        state: &mut BatchRunState,
        pool: &mut TilePool,
        config: &MosaicConfig,
        now_ms: &mut f64,
        interval_ms: f64,
    ) -> (Vec<ProgressEvent>, Vec<ResultBatch>) {
        let mut progress_events = Vec::new();
        let mut batches = Vec::new();
        while !state.is_done() {
            let s = state.step(pool, config, Some(*now_ms));
            *now_ms += interval_ms;
            if let Some(event) = s.progress {
                progress_events.push(event);
            }
            if let Some(batch) = s.result {
                batches.push(batch);
            }
            if s.done {
                break;
            }
        }
        (progress_events, batches)
    }

    #[test]
    fn batch_stepping_equals_single_shot_output() {
        // 行バッチ駆動(M5)と一括実行(M4 経路)は同一の結果になること。
        // 完了条件(handoff/04 M2): ゴールデン相当の固定入力比較
        let f = TestImage::new(96, 48, 24);
        let single = {
            let mut pool = setup_pool(4);
            run_phases(&f.grid, &f.features, &mut pool, &f.config, &f.rgba)
                .expect("run should succeed")
        };
        let mut state = BatchRunState::new(f.grid, &f.features, &f.rgba);
        let mut pool = setup_pool(4);
        let (events, batches) = drive(&mut state, &mut pool, &f.config, &mut 0.0, 16.0);
        assert!(state.is_done());
        assert!(!state.is_canceled());

        // 部分結果を組み合わせると完成画像と一致する
        // 行番号はブロック行(row_batch 単位)。画素行へは block_size を掛けて写像する
        let mut combined = vec![0_u8; f.rgba.len()];
        for batch in &batches {
            let begin =
                batch.row_begin as usize * f.grid.block_size as usize * f.grid.width as usize * 4;
            combined[begin..begin + batch.rgba.len()].copy_from_slice(&batch.rgba);
        }
        assert_eq!(combined, single.rgba);
        // 部分結果は行を欠かず、順序も行バッチ昇順(7.4: 抜けなく反映されること)
        let mut row = 0_u32;
        for batch in &batches {
            assert_eq!(batch.row_begin, row);
            row = batch.row_end;
        }
        assert_eq!(row, f.grid.rows);

        // 進捗イベントはマッチ済みブロック数を単調増加で、最後は必ず 100% になる
        let mut prev_assigned = 0_u32;
        for event in &events {
            assert!(event.assigned_blocks >= prev_assigned);
            prev_assigned = event.assigned_blocks;
        }
        let last = events.last().expect("at least one progress event");
        assert_eq!(last.assigned_blocks, f.grid.total_blocks);
        assert!((last.overall_ratio - 1.0).abs() < 1e-6);
    }

    #[test]
    fn batch_progress_respects_throttle() {
        // 進捗イベント間隔が仕様どおり(完了条件 handoff/04 M5):
        // 1 バッチあたりの overall 変化が 1% 未満になるサイズ(rows=542、
        // batch=4)で、仮想時刻を 8ms ずつ進めると 16ms 条件が支配し、
        // 半数程度のバッチしか発火しない
        let rgba = test_image(24, 13_000); // cols=1, rows=542
        let grid = crate::grid::compute_grid_info(24, 13_000, 24);
        let features = crate::grid::compute_block_features(&rgba, 24, 13_000, 24);
        let config = MosaicConfig {
            row_batch: 4,
            ..MosaicConfig::default()
        };
        let mut state = BatchRunState::new(grid, &features, &rgba);
        let mut pool = setup_pool(4);

        let mut now = 0.0_f64;
        let mut emit_at: Vec<(f64, ProgressEvent)> = Vec::new();
        let mut steps = 0_usize;
        while !state.is_done() {
            let s = state.step(&mut pool, &config, Some(now));
            if let Some(event) = s.progress {
                emit_at.push((now, event));
            }
            now += 8.0;
            steps += 1;
            if s.done {
                break;
            }
        }
        // 時間条件: 発火間隔は常に 16ms 以上(7.2)。
        // ただし完了時の最終イベントは force 発火のためにこの限りではない
        for pair in emit_at[..emit_at.len().saturating_sub(1)].windows(2) {
            assert!(
                pair[1].0 - pair[0].0 >= 16.0,
                "event interval must be >= 16ms"
            );
        }
        // 抑制が効いている: 全 step ではなく概ね半数の発火
        assert!(
            (emit_at.len() >= steps / 2) && emit_at.len() < steps,
            "throttle fired {} of {} steps",
            emit_at.len(),
            steps
        );
        // 最終イベントは必ず 100% に届く
        let last = emit_at.last().expect("final event exists");
        assert!((last.1.overall_ratio - 1.0).abs() < 1e-6);
        assert_eq!(last.1.assigned_blocks, grid.total_blocks);
        assert!((last.1.phase_ratio - 1.0).abs() < 1e-6);
    }

    #[test]
    fn batch_progress_phase_codes_and_weights() {
        // フェーズ ID と全体配分: run は P3 + P4 のみ(7.1 スキップ再配分)。
        // P3 完了時点で overall は 55/70 = 0.7857、完了で 1.0
        let f = TestImage::new(96, 480, 24); // rows=20, batch 8 → P3 3 バッチ
        let mut state = BatchRunState::new(f.grid, &f.features, &f.rgba);
        let mut pool = setup_pool(4);
        let mut now = 0.0_f64;
        let mut last_match_overall = None;
        let mut seen_compose_phase = false;
        while !state.is_done() {
            let s = state.step(&mut pool, &f.config, Some(now));
            now += 20.0;
            if let Some(event) = s.progress {
                match event.phase {
                    Phase::Match => {
                        // 合成中ではないので assigned_blocks はマッチ済み数
                        assert!(event.assigned_blocks <= f.grid.total_blocks);
                        last_match_overall = Some(event.overall_ratio);
                    }
                    Phase::Compose => {
                        seen_compose_phase = true;
                        // 合成中のブロック進捗バーは 100% を維持(基本設計書 2.3)
                        assert_eq!(event.assigned_blocks, f.grid.total_blocks);
                        // P3 の最終値(55/70)を下回らない(単調)
                        if let Some(prev) = last_match_overall {
                            assert!(event.overall_ratio >= prev);
                        }
                    }
                    _ => panic!("unexpected phase in run: {event:?}"),
                }
            }
            if s.done {
                break;
            }
        }
        // P3 完了時の overall = 55/70
        let match_final = last_match_overall.expect("match phase emits progress");
        assert!(
            (match_final - 0.55 / 0.70).abs() < 1e-5,
            "got {match_final}"
        );
        assert!(seen_compose_phase);
    }

    #[test]
    fn batch_cancel_at_match_phase_retains_seed() {
        // キャンセルがバッチ境界で効く(完了条件 handoff/04 M5)。
        // マッチング中のキャンセル: 出力はシード(メイン画像)のまま
        let f = TestImage::new(96, 384, 24); // rows=16
        let mut state = BatchRunState::new(f.grid, &f.features, &f.rgba);
        let mut pool = setup_pool(4);
        let now = 0.0_f64;
        // P3 の 1 バッチだけ進める(2 行バッチ以上ある)
        let s = state.step(&mut pool, &f.config, Some(now));
        assert!(!s.done);
        assert!(s.result.is_none(), "match phase has no result batch");
        assert_eq!(f.grid.rows, 16, "precondition: multiple match batches");

        state.cancel();
        assert!(state.is_done());
        assert!(state.is_canceled());
        // キャンセル後の step は no-op
        let s = state.step(&mut pool, &f.config, Some(now));
        assert!(s.done && s.progress.is_none() && s.result.is_none());

        // 既存のマッチ結果・現時点までの合成結果(未合成行=シード)は保持される
        let out = state
            .take_output()
            .expect("canceled run keeps partial output");
        assert_eq!(out.len(), f.rgba.len());
        assert_eq!(out, f.rgba, "no rows composed yet, output equals seed");
    }

    #[test]
    fn batch_cancel_at_compose_phase_keeps_composed_rows() {
        // 合成 1 バッチ完了後のキャンセル: 完成行は合成結果、未完成行はシード
        let f = TestImage::new(96, 384, 24);
        let mut state = BatchRunState::new(f.grid, &f.features, &f.rgba);
        let mut pool = setup_pool(4);
        let mut now = 0.0_f64;
        // P3(2 バッチ)を完走
        let s1 = state.step(&mut pool, &f.config, Some(now));
        now += 16.0;
        assert!(!s1.done);
        let s2 = state.step(&mut pool, &f.config, Some(now));
        now += 16.0;
        assert!(!s2.done);
        // P4 の 1 バッチ目(行 0..8)を完了させる
        let s3 = state.step(&mut pool, &f.config, Some(now));
        assert!(!s3.done);
        let batch = s3.result.expect("compose batch emits result");
        assert_eq!(batch.row_begin, 0);
        assert_eq!(batch.row_end, 8);

        state.cancel();
        assert!(state.is_canceled());
        let out = state
            .take_output()
            .expect("canceled run keeps partial output");

        // 比較: 完走時の同一行範囲の合成結果と一致し、以降はメイン画像
        let full = {
            let mut pool = setup_pool(4);
            run_phases(&f.grid, &f.features, &mut pool, &f.config, &f.rgba)
                .expect("run should succeed")
                .rgba
        };
        let composed_bytes = 8 * to_usize(f.grid.block_size) * to_usize(f.grid.width) * 4; // 8 ブロック行分のピクセル
        assert_eq!(&out[..composed_bytes], &full[..composed_bytes]);
        assert_eq!(&out[composed_bytes..], &f.rgba[composed_bytes..]);
    }

    #[test]
    fn batch_step_after_done_is_noop() {
        let f = TestImage::new(96, 48, 24);
        let mut state = BatchRunState::new(f.grid, &f.features, &f.rgba);
        let mut pool = setup_pool(4);
        let mut now = 0.0_f64;
        while !state.is_done() {
            let s = state.step(&mut pool, &f.config, Some(now));
            now += 16.0;
            if s.done {
                break;
            }
        }
        // 完了後の連続呼び出しも安全(no-op)
        for _ in 0..3 {
            let s = state.step(&mut pool, &f.config, Some(now));
            assert!(s.done && s.progress.is_none() && s.result.is_none());
        }
        assert!(!state.is_canceled());
    }

    #[test]
    fn batch_empty_pool_is_immediately_done() {
        // 防御: プール空での駆動は進行せず即時完了(呼び出し側で案内する)
        let f = TestImage::new(96, 48, 24);
        let mut state = BatchRunState::new(f.grid, &f.features, &f.rgba);
        let mut pool = TilePool::new();
        let s = state.step(&mut pool, &f.config, Some(0.0));
        assert!(s.done && s.progress.is_none() && s.result.is_none());
        assert!(!state.is_canceled());
    }

    #[test]
    fn seed_rgba_length_mismatch_is_rejected() {
        let f = TestImage::new(96, 48, 24);
        let short = vec![0_u8; f.rgba.len() - 4];
        let result = std::panic::catch_unwind(|| {
            let _ = BatchRunState::new(f.grid, &f.features, &short);
        });
        assert!(result.is_err(), "seed length mismatch must panic");
    }
}
