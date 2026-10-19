//! フェーズ制御・オーケストレーション(詳細設計書 4.1 / 4.4 / 7 章 / 8.1)。
//!
//! M5: P3(マッチング)と P4(合成)を行バッチ単位で進める
//! [`BatchRunState`] を提供する。
//! M6: 差分再マッチ(未確定ブロックのマッチ・差し替え評価)を
//! 同一の実装で扱う。差分再マッチでは再マッチしたブロック行のみを
//! 再合成し、出力バッファは現時点の合成結果をシードとして再利用する。
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
use crate::match_engine::{
    assignments_to_matches, evaluate_swap_range, match_unmatched_range, MatchResult,
};
use crate::metrics::SpanAgg;
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

/// run 内のスパン計測結果(完了・キャンセル時にホストが取り出す。M7)
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RunSpans {
    /// P3 マッチングの行バッチ所要 (累計・回数・最大 = handoff/05 §3)
    pub p3_match_batch: SpanAgg,
    /// P4 合成の行バッチ所要
    pub p4_compose_batch: SpanAgg,
}

impl RunSpans {
    /// done 時にホストへ渡すため取り出す(以降の値は 0)
    pub fn take(&mut self) -> RunSpans {
        std::mem::take(self)
    }
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

/// マッチングの実行モード(詳細設計書 4.4 差分再マッチ)。
///
/// P3 の走査は常に「ブロック番号昇順 × タイル ID 昇順」で行い、モードは
/// 各ブロックへの働きかけ(全マッチ / 未確定のみ / 差し替え評価)だけを変える。
/// これによりフルランと差分再マッチが単一の実装を共有する(単一の情報源)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchMode {
    /// 全ブロックをマッチする(初回生成・ブロックサイズ変更後の再生成)
    Full,
    /// 未確定(None)ブロックのみマッチする(タイル追加・削除後の差分再マッチ)。
    /// タイル追加時は「未確定ブロックを優先的にマッチする」(詳細設計書 4.4)
    FillUnmatched,
    /// 差し替え評価のみ行う(全ブロック確定済みでタイルが追加された場合の
    /// 差分再マッチ)。現割当より improve_margin 以上良い候補がある場合のみ
    /// 差し替える(詳細設計書 4.4)
    SwapEvaluate,
}

/// 進行中のフェーズ(run の実行順序は P3 → P4 に固定)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunPhase {
    /// P3 マッチング(ブロック位置 match_next_block 以降が未走査)
    Matching,
    /// P4 合成(再合成対象行 dirty のうち compose_cursor 以降が未合成)
    Composing,
}

/// 行バッチで駆動する実行状態(詳細設計書 4.4 手順 / 7.4 / 8.1)。
///
/// - 内部に P1 出力(グリッド・ブロック特徴量)の実行用スナップショットを持つ
///   (run 中のホスト側変更の影響を受けない)
/// - 割当表 `assigned` は全ブロック分の `Option<u64>`(None = 未確定)。
///   フルランは全要素 None で開始し、完了・キャンセル時に呼び出し側へ返す
///   (M6: 差分再マッチが既存割当を基礎に動作するため)
/// - 出力バッファ `out` の初期値はシード(フルランはメイン画像、
///   差分再マッチは現時点の合成結果)。完了時には再合成対象行が
///   合成で上書きされ、キャンセル時には「現時点までの合成結果」として取り出される
pub struct BatchRunState {
    grid: GridInfo,
    /// ブロック特徴量の実行用スナップショット
    features: Vec<BlockFeature>,
    /// 割当表(全ブロック分。None = 未確定)
    assigned: Vec<Option<u64>>,
    /// マッチングの実行モード
    mode: MatchMode,
    /// P3 進捗: 次に走査するブロック位置
    match_next_block: usize,
    /// 確定済み(割当あり)ブロック数(進捗イベントの assigned_blocks。
    /// 差分再マッチでは「全体ブロック数に対して計上」する: 詳細設計書 4.4)
    assigned_count: u32,
    /// 再マッチ・差し替えが発生したブロック行のフラグ(P4 の合成範囲)
    dirty_block_rows: Vec<bool>,
    /// 再合成対象行(昇順)。P3 完了時に確定する
    compose_dirty_rows: Vec<u32>,
    /// P4 進捗: 合成済み dirty 行数
    composed_dirty_rows: u32,
    /// P4 進捗: 次に合成する compose_dirty_rows の位置
    compose_cursor: usize,
    phase: RunPhase,
    /// 全体進捗の配分。run に含まれるのは P3 + P4 のみ(P1/P2 は先行完了のため、
    /// 詳細設計書 7.1 の「スキップされたフェーズの再配分」で正規化する)
    plan: PhasePlan,
    throttle: ProgressThrottle,
    /// 合成結果バッファ(シードで初期化。完成時 / キャンセル時に取り出す)
    out: Vec<u8>,
    /// バッチ境界のスパン計測(M7: handoff/05 §3。フェーズ境界・バッチ境界のみ)
    spans: RunSpans,
    canceled: bool,
    done: bool,
}

impl BatchRunState {
    /// 実行状態を生成する(P3 開始前。フルマッチモード)。
    ///
    /// - `seed_rgba`: メイン画像の RGBA(出力バッファの行シード)。
    ///   長さは `grid.width * grid.height * 4` と一致させる
    pub fn new(grid: GridInfo, block_features: &[BlockFeature], seed_rgba: &[u8]) -> Self {
        let total = to_usize(grid.total_blocks);
        Self::with_mode(
            grid,
            block_features,
            vec![None; total],
            seed_rgba,
            MatchMode::Full,
        )
    }

    /// 差分再マッチの実行状態を生成する(M6: 詳細設計書 4.4 差分再マッチ)。
    ///
    /// - `assigned`: 現在の割当表(全ブロック分。None = 未確定)。
    ///   本状態が保持し、完了・キャンセル時に [`take_assignments`] で返す
    /// - `seed_rgba`: 出力バッファのシード(現時点の合成結果。
    ///   再合成対象行のみが上書きされる。全要素 None のフル相当では
    ///   メイン画像を渡す)
    /// - `mode`: [`MatchMode::FillUnmatched`] / [`MatchMode::SwapEvaluate`] /
    ///   [`MatchMode::Full`](割当表が空で全ブロック未確定の場合。[`BatchRunState::new`]
    ///   と同一の挙動だがシードが合成結果を参照しうる点が異なる)
    ///
    /// [`take_assignments`]: BatchRunState::take_assignments
    pub fn new_rematch(
        grid: GridInfo,
        block_features: &[BlockFeature],
        assigned: Vec<Option<u64>>,
        seed_rgba: &[u8],
        mode: MatchMode,
    ) -> Self {
        Self::with_mode(grid, block_features, assigned, seed_rgba, mode)
    }

    /// 共通の構築処理(モード指定)
    fn with_mode(
        grid: GridInfo,
        block_features: &[BlockFeature],
        assigned: Vec<Option<u64>>,
        seed_rgba: &[u8],
        mode: MatchMode,
    ) -> Self {
        let size = to_usize(grid.width) * to_usize(grid.height) * 4;
        assert_eq!(seed_rgba.len(), size, "seed rgba buffer length mismatch");
        assert_eq!(
            assigned.len(),
            to_usize(grid.total_blocks),
            "assignment table length mismatch"
        );
        let assigned_count = assigned.iter().filter(|slot| slot.is_some()).count() as u32;
        // フルランは全ブロック行が再合成対象。差分再マッチはマッチ時に確定する
        let mut dirty_block_rows = vec![false; to_usize(grid.rows)];
        if mode == MatchMode::Full {
            dirty_block_rows.iter_mut().for_each(|dirty| *dirty = true);
        }
        BatchRunState {
            grid,
            features: block_features.to_vec(),
            assigned,
            mode,
            match_next_block: 0,
            assigned_count,
            dirty_block_rows,
            compose_dirty_rows: Vec::new(),
            composed_dirty_rows: 0,
            compose_cursor: 0,
            phase: RunPhase::Matching,
            plan: PhasePlan::new(vec![Phase::Match, Phase::Compose]),
            throttle: ProgressThrottle::new(),
            out: seed_rgba.to_vec(),
            spans: RunSpans::default(),
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

    /// 現在の割当表を取り出す(完了 / キャンセル後。M6: 差分再マッチの基礎)。
    /// 取り出し後は空になる。キャンセル時は確定済みの分のみが入る
    pub fn take_assignments(&mut self) -> Vec<Option<u64>> {
        std::mem::take(&mut self.assigned)
    }

    /// バッチスパンの実測結果を取り出す(M7: handoff/05 §3)。
    /// 取り出し後は 0 クリアされる
    pub fn take_spans(&mut self) -> RunSpans {
        self.spans.take()
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
        let cols = self.grid.cols;
        let total = to_usize(self.grid.total_blocks);
        let batch_blocks = to_usize(config.row_batch.max(1)) * to_usize(cols);
        let block_begin = self.match_next_block.min(total);
        let block_end = (block_begin + batch_blocks).min(total);
        let span_start = crate::metrics::now_ms();

        match self.mode {
            MatchMode::Full | MatchMode::FillUnmatched => {
                let matched = match_unmatched_range(
                    &self.features,
                    cols,
                    pool,
                    config,
                    &mut self.assigned,
                    block_begin,
                    block_end,
                );
                // 確定済みブロック数は本バッチで新たにマッチした分だけ増える
                // (差分再マッチでは既存割当を含む範囲を走査するため、
                // 範囲全体の再計上はしない)
                self.assigned_count += matched.len() as u32;
                for position in matched {
                    let row = to_usize(position / cols);
                    self.dirty_block_rows[row] = true;
                }
            }
            MatchMode::SwapEvaluate => {
                let swapped = evaluate_swap_range(
                    &self.features,
                    cols,
                    pool,
                    config,
                    &mut self.assigned,
                    block_begin,
                    block_end,
                );
                for position in swapped {
                    let row = to_usize(position / cols);
                    self.dirty_block_rows[row] = true;
                }
            }
        }
        self.match_next_block = block_end;
        // P3 バッチの所要を累積する(M7: handoff/05 §3。時計なしは 0 で回数のみ)
        self.spans
            .p3_match_batch
            .record(crate::metrics::now_ms() - span_start);

        // P3 の phase_ratio は「マッチ済みブロック数 / total_blocks」(詳細設計書 7.1)。
        // 差分再マッチでも assigned_blocks を全体ブロック数に対して計上する(4.4)
        let progress = self.emit(
            Phase::Match,
            self.assigned_count as f32 / self.grid.total_blocks as f32,
            self.assigned_count,
            now_ms,
            false,
        );
        if block_end >= total {
            // P3 完了 → P4 合成へ移行(再合成対象行を確定させる)
            self.compose_dirty_rows = self
                .dirty_block_rows
                .iter()
                .enumerate()
                .filter(|(_, dirty)| **dirty)
                .map(|(row, _)| u32::try_from(row).expect("row fits u32"))
                .collect();
            self.composed_dirty_rows = 0;
            self.compose_cursor = 0;
            self.phase = RunPhase::Composing;
        }
        Step {
            progress,
            result: None,
            done: false,
        }
    }

    /// P4 合成の 1 行バッチ。再合成対象行(dirty 行)を合成して部分結果を返す
    fn step_compose(
        &mut self,
        pool: &TilePool,
        config: &MosaicConfig,
        now_ms: Option<f64>,
    ) -> Step {
        let batch = config.row_batch.max(1);
        let total_dirty = self.compose_dirty_rows.len();
        // 再合成対象行から次の連続区間(最大 row_batch 行)を取り出す。
        // フルラン(dirty = 全行)では row_batch 行ずつの連続区間になり、
        // M4/M5 と同一の部分結果の粒度になる
        let Some((begin, end)) = self.next_dirty_range(batch) else {
            // 合成対象なし(差分再マッチで再マッチ・差し替えが発生しなかった)。
            // 既存の合成結果を保持したまま完了する
            self.done = true;
            let progress = self.emit(Phase::Compose, 1.0, self.grid.total_blocks, now_ms, true);
            return Step {
                progress,
                result: None,
                done: true,
            };
        };
        let span_start = crate::metrics::now_ms();
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
        // P4 バッチの所要を累積する(M7: 時計なしは 0 で回数のみ)
        self.spans
            .p4_compose_batch
            .record(crate::metrics::now_ms() - span_start);
        self.composed_dirty_rows += end - begin;

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

        let final_step = self.compose_cursor >= total_dirty;
        // 合成中もブロック進捗バーは 100% を維持する(基本設計書 2.3)。
        // assigned_blocks には全ブロック数を通知する
        let progress = self.emit(
            Phase::Compose,
            self.composed_dirty_rows as f32 / total_dirty as f32,
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

    /// 再合成対象行から次の連続区間 `[begin, end)` を取り出す
    /// (最大 `max_rows` 行。昇順の dirty 行リストの先頭から消費する)
    fn next_dirty_range(&mut self, max_rows: u32) -> Option<(u32, u32)> {
        let start = *self.compose_dirty_rows.get(self.compose_cursor)?;
        let max_rows = to_usize(max_rows);
        let mut end = start + 1;
        let mut taken = 1_usize;
        self.compose_cursor += 1;
        while self.compose_cursor < self.compose_dirty_rows.len() && taken < max_rows {
            let next = self.compose_dirty_rows[self.compose_cursor];
            if next == end {
                end += 1;
                taken += 1;
                self.compose_cursor += 1;
            } else {
                break;
            }
        }
        Some((start, end))
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

/// u32 → usize の変換(wasm32 でも 4 GB 未満の寸法を安全に扱う)
fn to_usize(value: u32) -> usize {
    usize::try_from(value).expect("value fits usize")
}

/// P3 + P4 を一括実行する(同期 API・フルマッチモード)。
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
    let matches = assignments_to_matches(&state.take_assignments());
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

    #[test]
    fn rematch_block_size_change_budget() {
        // 完了条件(handoff/04 M6): ブロックサイズ変更時の再生成は
        // 1.5 秒以内(詳細設計書 10 章。P2 スキップの効果)。
        // S-small 相当(1600x1200 / 50 枚)でフル再マッチ(P1+P3+P4、P2 スキップ)
        // を計測し、緩い上限でリグレッション検知とする
        let rgba = test_image(1600, 1200);
        let mut pool = setup_pool(50);
        let config = MosaicConfig::default();

        // 初回生成(24px)
        let grid = crate::grid::compute_grid_info(1600, 1200, 24);
        let features = crate::grid::compute_block_features(&rgba, 1600, 1200, 24);
        let output = run_phases(&grid, &features, &mut pool, &config, &rgba)
            .expect("initial run should succeed");

        // ブロックサイズ変更(32px): P1 再計算 + P3/P4 再生成(P2 スキップ)
        let start = std::time::Instant::now();
        let grid = crate::grid::compute_grid_info(1600, 1200, 32);
        let features = crate::grid::compute_block_features(&rgba, 1600, 1200, 32);
        let regenerated = run_phases(&grid, &features, &mut pool, &config, &rgba)
            .expect("regeneration should succeed");
        let elapsed = start.elapsed();
        assert_eq!(regenerated.rgba.len(), 1600 * 1200 * 4);
        assert_ne!(
            regenerated.matches, output.matches,
            "grid change re-matches all"
        );
        // 詳細設計書 10 章: ブロックサイズ変更時の再生成 1.5 秒以内。
        // S-small(12MP の約 1/8)での実測に対し緩い上限(1 秒)で検知する
        assert!(
            elapsed.as_millis() < 1_000,
            "block size regeneration took {elapsed:?}, budget is 1,000ms"
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

    /// M6 差分再マッチ: キャンセルで生じた未確定ブロックのみをマッチする
    /// (FillUnmatched。詳細設計書 4.4「未確定ブロックを優先的にマッチする」)
    #[test]
    fn rematch_fill_unmatched_completes_partial_run() {
        let f = TestImage::new(96, 384, 24); // cols=4, rows=16, 64 ブロック
        let mut pool = setup_pool(4);

        // フルランを 1 行バッチ(8 行 = 32 ブロック)だけ進めて中断する
        let mut state = BatchRunState::new(f.grid, &f.features, &f.rgba);
        let s = state.step(&mut pool, &f.config, Some(0.0));
        assert!(!s.done);
        assert_eq!(s.result, None, "match phase emits no result batch");
        state.cancel();
        let partial_assigned = state.take_assignments();
        let partial_out = state.take_output().expect("canceled run keeps output");
        assert_eq!(
            partial_assigned
                .iter()
                .filter(|slot| slot.is_some())
                .count(),
            32,
            "one batch of 8 rows x 4 cols is settled"
        );

        // タイルを追加して差分再マッチ(未確定のみ)。シードは現時点の合成結果
        let mut pool = setup_pool(4);
        let mut feature_arg = vec![0_u8; FEATURE_THUMB as usize * FEATURE_THUMB as usize * 4];
        let size = 64_usize;
        let mut compose_arg = vec![0_u8; size * size * 4];
        for (i, pixel) in feature_arg.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            pixel[0] = ((i * 13) % 256) as u8;
            pixel[1] = ((i * 17 + 5) % 256) as u8;
            pixel[2] = ((i * 19 + 200) % 256) as u8;
            pixel[3] = 255;
        }
        for (i, pixel) in compose_arg.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            pixel[0] = ((i * 11 + 5) % 256) as u8;
            pixel[1] = ((i * 23 + 5) % 256) as u8;
            pixel[2] = ((i * 29 + 5) % 256) as u8;
            pixel[3] = 255;
        }
        pool.add_tile(5, &feature_arg, &compose_arg, 64, 64)
            .expect("tile registration should succeed");
        // 使用回数を現割当表から再集計する(4.4: ペナルティの連続性を保つ)
        pool.recount_usage(&partial_assigned);

        let mut rematch = BatchRunState::new_rematch(
            f.grid,
            &f.features,
            partial_assigned,
            &partial_out,
            MatchMode::FillUnmatched,
        );
        let mut now = 0.0_f64;
        let mut batches = Vec::new();
        let mut events = Vec::new();
        while !rematch.is_done() {
            let s = rematch.step(&mut pool, &f.config, Some(now));
            now += 16.0;
            if let Some(batch) = s.result {
                batches.push(batch);
            }
            if let Some(event) = s.progress {
                events.push(event);
            }
            if s.done {
                break;
            }
        }
        assert!(rematch.is_done());

        // 未確定ブロックがすべて確定する
        let final_assigned = rematch.take_assignments();
        assert!(final_assigned.iter().all(Option::is_some));
        assert_eq!(final_assigned.len(), 64);

        // 再合成は未確定ブロックを含む行(8..16 行)のみ。既存行は保持される
        assert!(
            !batches.is_empty(),
            "dirty rows must produce result batches"
        );
        for batch in &batches {
            assert!(
                batch.row_begin >= 8,
                "only unmatched rows (8..16) are recomposed, got {}..{}",
                batch.row_begin,
                batch.row_end
            );
        }
        let composed = rematch.take_output().expect("completed rematch output");
        let unchanged_bytes = 8 * to_usize(f.grid.block_size) * to_usize(f.grid.width) * 4; // 8 ブロック行分
        assert_eq!(
            &composed[..unchanged_bytes],
            &partial_out[..unchanged_bytes],
            "already composed rows must be kept"
        );

        // 進捗: assigned_blocks は全体ブロック数に対して単調増加し、最後は 100%
        let mut prev = 32_u32;
        for event in &events {
            assert!(event.assigned_blocks >= prev);
            prev = event.assigned_blocks;
        }
        let last = events.last().expect("final progress event exists");
        assert_eq!(last.assigned_blocks, f.grid.total_blocks);
        assert!((last.overall_ratio - 1.0).abs() < 1e-6);
    }

    /// M6 差し替え評価: 全ブロック確定済みでタイル追加された場合、
    /// improve_margin 以上良い候補があるブロックのみ差し替える
    /// (詳細設計書 4.4「差し替え評価のみ行う」)
    #[test]
    fn rematch_swap_evaluates_improvement_margin() {
        // 単色のメイン画像(全ブロックの mean_lab が同一)で決定的な条件を作る
        let rgba = uniform_gray_image(96, 48); // cols=4, rows=2, 8 ブロック
        let grid = crate::grid::compute_grid_info(96, 48, 24);
        let features = crate::grid::compute_block_features(&rgba, 96, 48, 24);
        let block_lab = crate::color::srgb8_to_lab(127, 127, 127);
        let config = MosaicConfig {
            improve_margin: 1.0,
            ..MosaicConfig::default()
        };

        // 初回は遠いタイル(ΔE ≈ 20 / 25)しかない
        let mut pool = pool_with_features(&[
            ([(block_lab[0] + 20.0) as f32, 0.0, 0.0], 0.0, 1),
            ([(block_lab[0] + 25.0) as f32, 0.0, 0.0], 0.0, 2),
        ]);
        let output_before =
            run_phases(&grid, &features, &mut pool, &config, &rgba).expect("run should succeed");
        let assigned_before: Vec<Option<u64>> = output_before
            .matches
            .iter()
            .map(|m| Some(m.tile_id))
            .collect();
        assert!(assigned_before.iter().all(|slot| *slot != Some(9)));

        // 現割当と完全一致(ΔE=0)のタイルを追加 → 差し替え評価で全ブロックが
        // 改善(改善幅 ≈ 20 − 使用ペナルティ > margin)する
        pool.add_tile(
            9,
            &flat_gray_buffer(FEATURE_THUMB as usize * FEATURE_THUMB as usize * 4, 200),
            &flat_gray_buffer(64 * 64 * 4, 200),
            64,
            64,
        )
        .expect("tile registration should succeed");
        // 追加タイルの特徴量をブロック色と完全一致させる(サムネイル計算値から固定へ)
        pool.overwrite_feature_for_test(crate::tile::TileFeature {
            id: 9,
            thumb_w: 64,
            thumb_h: 64,
            mean_lab: [
                block_lab[0] as f32,
                block_lab[1] as f32,
                block_lab[2] as f32,
            ],
            detail: 0.0,
            usage: 0,
        });
        // 使用回数を現割当表から再集計してから差し替え評価に臨む(4.4)
        pool.recount_usage(&assigned_before);

        let mut rematch = BatchRunState::new_rematch(
            grid,
            &features,
            assigned_before,
            &output_before.rgba,
            MatchMode::SwapEvaluate,
        );
        let mut now = 0.0_f64;
        while !rematch.is_done() {
            let s = rematch.step(&mut pool, &config, Some(now));
            now += 16.0;
            if s.done {
                break;
            }
        }
        let assigned_after = rematch.take_assignments();
        // 全ブロックがタイル 9 へ差し替えられる(使用ペナルティ・隣接ペナルティ
        // を含めても遠いタイルより十分良い)
        assert!(assigned_after.iter().all(|slot| *slot == Some(9)));
        // 使用回数は再マッチ後に現割当表から再集計される
        pool.recount_usage(&assigned_after);
        assert_eq!(pool.feature(9).expect("tile 9").usage, grid.total_blocks);

        // 合成結果も差し替わる(出力バッファはシード = 旧合成結果の上に更新)
        let composed = rematch.take_output().expect("completed rematch output");
        assert_eq!(composed.len(), output_before.rgba.len());
        assert_ne!(composed, output_before.rgba);
    }

    /// M6 タイル削除: 削除タイルが割当られていたブロックのみ未確定化して
    /// 再マッチする(詳細設計書 4.4「タイル削除時」)
    #[test]
    fn rematch_after_tile_removal_retargets_only_affected_blocks() {
        // 単色のメイン画像で両タイルが使われる確定的な割当を作る
        let rgba = uniform_gray_image(96, 48); // 8 ブロック
        let grid = crate::grid::compute_grid_info(96, 48, 24);
        let features = crate::grid::compute_block_features(&rgba, 96, 48, 24);
        let block_lab = crate::color::srgb8_to_lab(127, 127, 127);
        let mut pool = pool_with_features(&[
            ([(block_lab[0] + 10.0) as f32, 0.0, 0.0], 0.0, 1),
            ([(block_lab[0] + 12.0) as f32, 0.0, 0.0], 0.0, 2),
        ]);
        let config = MosaicConfig::default();
        let output =
            run_phases(&grid, &features, &mut pool, &config, &rgba).expect("run should succeed");
        let assigned: Vec<Option<u64>> = output.matches.iter().map(|m| Some(m.tile_id)).collect();
        // ブロックごとに割当が分かれていること(両タイルが使われる)
        assert!(assigned.contains(&Some(1)));
        assert!(assigned.contains(&Some(2)));

        // タイル 2 を削除: 割当表の該当ブロックを未確定にする(ホスト側の操作)
        pool.remove_tile(2).expect("tile removal should succeed");
        let removed_positions: Vec<usize> = assigned
            .iter()
            .enumerate()
            .filter(|(_, slot)| **slot == Some(2))
            .map(|(i, _)| i)
            .collect();
        let mut assigned_after_removal = assigned.clone();
        for position in &removed_positions {
            assigned_after_removal[*position] = None;
        }
        pool.recount_usage(&assigned_after_removal);

        let mut rematch = BatchRunState::new_rematch(
            grid,
            &features,
            assigned_after_removal,
            &output.rgba,
            MatchMode::FillUnmatched,
        );
        let mut now = 0.0_f64;
        let mut recomposed_rows = Vec::new();
        while !rematch.is_done() {
            let s = rematch.step(&mut pool, &config, Some(now));
            now += 16.0;
            if let Some(batch) = s.result {
                for row in batch.row_begin..batch.row_end {
                    recomposed_rows.push(row);
                }
            }
            if s.done {
                break;
            }
        }
        let final_assigned = rematch.take_assignments();
        // すべてのブロックが現プール(タイル 1)で確定する
        assert!(final_assigned.iter().all(|slot| *slot == Some(1)));
        // 再合成は削除タイルが割当られていたブロックの行のみ(同一行の
        // 複数ブロックは 1 行にまとまる)
        let mut expected_rows: Vec<u32> = removed_positions
            .iter()
            .map(|position| (position / grid.cols as usize) as u32)
            .collect();
        expected_rows.dedup();
        assert_eq!(recomposed_rows, expected_rows);
    }

    /// M6: 再マッチ・差し替えが発生しない差分再マッチは何も合成せず完了する
    #[test]
    fn rematch_without_targets_is_a_noop() {
        let f = TestImage::new(96, 48, 24);
        let mut pool = setup_pool(4);
        let output = run_phases(&f.grid, &f.features, &mut pool, &f.config, &f.rgba)
            .expect("run should succeed");
        let assigned: Vec<Option<u64>> = output.matches.iter().map(|m| Some(m.tile_id)).collect();

        let mut rematch = BatchRunState::new_rematch(
            f.grid,
            &f.features,
            assigned,
            &output.rgba,
            MatchMode::FillUnmatched,
        );
        let mut now = 0.0_f64;
        let mut events = Vec::new();
        let mut batches = Vec::new();
        while !rematch.is_done() {
            let s = rematch.step(&mut pool, &f.config, Some(now));
            now += 16.0;
            if let Some(event) = s.progress {
                events.push(event);
            }
            if let Some(batch) = s.result {
                batches.push(batch);
            }
            if s.done {
                break;
            }
        }
        assert!(rematch.is_done());
        assert!(!rematch.is_canceled());
        assert!(batches.is_empty(), "no dirty rows must be recomposed");
        // 完了イベントのみが発火する(進捗バーは 100% を維持)
        let last = events.last().expect("final event exists");
        assert_eq!(last.assigned_blocks, f.grid.total_blocks);
        assert!((last.overall_ratio - 1.0).abs() < 1e-6);
        // 合成結果は変更されない
        let composed = rematch.take_output().expect("noop rematch keeps output");
        assert_eq!(composed, output.rgba);
    }

    /// テスト用: (mean_lab, detail, id) の並びからプールを直接構築する
    /// (match_engine の pool_with_tiles と同じ構成)
    fn pool_with_features(tiles: &[([f32; 3], f32, u64)]) -> TilePool {
        let mut pool = TilePool::new();
        for &(lab, detail, id) in tiles {
            let feature = crate::tile::TileFeature {
                id,
                thumb_w: 64,
                thumb_h: 64,
                mean_lab: lab,
                detail,
                usage: 0,
            };
            // 特徴量サムネイル(32×32)・合成サムネイル(64×64)とも単色。
            // mean_lab / detail は overwrite_feature_for_test で固定値へ上書きする
            // (add_tile はサムネイルから計算するため、距離計算の条件を固定する)
            pool.add_tile(
                id,
                &flat_gray_buffer(FEATURE_THUMB as usize * FEATURE_THUMB as usize * 4, 100),
                &flat_gray_buffer(64 * 64 * 4, 100),
                64,
                64,
            )
            .expect("tile registration should succeed");
            pool.overwrite_feature_for_test(feature);
        }
        pool
    }

    /// 単色 RGBA バッファ(全ピクセル同一の灰色)
    fn flat_gray_buffer(bytes: usize, value: u8) -> Vec<u8> {
        let mut rgba = vec![0_u8; bytes];
        for pixel in rgba.as_chunks_mut::<4>().0 {
            pixel[0] = value;
            pixel[1] = value;
            pixel[2] = value;
            pixel[3] = 255;
        }
        rgba
    }

    /// 単色テスト画像(全ピクセル同一の灰色。全ブロックの特徴量が同一になる)
    fn uniform_gray_image(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            rgba.extend_from_slice(&[127, 127, 127, 255]);
        }
        rgba
    }
}
