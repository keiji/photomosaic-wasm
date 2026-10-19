//! 性能計測(スパン計測・メトリクス出力: handoff/05 性能の計測設計)。
//!
//! - 計測はコア内部に組み込む(外側からの JS タイマーは WASM↔JS の往復
//!   コストが混ざるため。handoff/05 §2)
//! - タイマー呼び出しはバッチ境界・フェーズ境界のみに限定する(ブロック単位では
//!   計らない。計測オーバーヘッドの排除)
//! - コアは時計を持たない(サンドボックス環境では `performance` が無い場合が
//!   あるため)。ホストが [`install_clock`] で単調時計を注入する。未注入の
//!   環境([`now_ms`] の戻り値 0.0)では時間値の計測は行われない
//!   ([`SpanAgg`] に時間 0 で累積するため、JSON 上は `ms: 0` になる)
//! - メトリクスの値はゴールデン画像テストの判定に使わない(環境差のため)
//! - 決定性ルール: 計測は記録のみを行い、処理結果には影響しない

use std::cell::RefCell;
use std::collections::VecDeque;

/// 計時関数(ミリ秒。単調な浮動小数点値を返す。Web: performance.now() 等)
type NowFn = Box<dyn Fn() -> f64>;

thread_local! {
    static CLOCK: RefCell<Option<NowFn>> = const { RefCell::new(None) };
}

/// 単調時計関数を注入する(wasm-host: `performance.now()` 相当)。
/// 2 回目の呼び出しで差し替えになる(テスト用)
pub fn install_clock(now: Box<dyn Fn() -> f64>) {
    CLOCK.with(|clock| {
        *clock.borrow_mut() = Some(now);
    });
}

/// 現在時刻をミリ秒で返す(時計未注入なら 0.0)。
///
/// スパンの開始・終了の 2 点で呼ぶ限定用法を想定(オーバーヘッド最小化)
/// 現在時刻をミリ秒で返す(時計未注入なら 0.0)。
///
/// スパンの開始・終了の 2 点で呼ぶ限定用法を想定(オーバーヘッド最小化)
pub fn now_ms() -> f64 {
    CLOCK.with(|clock| clock.borrow().as_ref().map_or(0.0, |now| now()))
}

/// 単一スパン ID の累積統計(handoff/05 §3 の「累計・回数・最大・平均」)
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SpanAgg {
    pub count: u32,
    pub total_ms: f64,
    pub max_ms: f64,
}

impl SpanAgg {
    /// 1 回分のスパン時間を累積する(負値・非有限値は無視する)
    pub fn record(&mut self, ms: f64) {
        if !ms.is_finite() || ms < 0.0 {
            return;
        }
        self.count += 1;
        self.total_ms += ms;
        self.max_ms = self.max_ms.max(ms);
    }

    /// 平均時間(回数 0 は 0.0)
    pub fn avg_ms(&self) -> f64 {
        if self.count == 0 {
            return 0.0;
        }
        self.total_ms / f64::from(self.count)
    }
}

/// スパン ID(安定識別子。handoff/05 §3 のスパン一覧に対応)
pub const SPAN_P1_GRID: &str = "p1_grid";
pub const SPAN_P1_BLOCK_FEATURES: &str = "p1_block_features";
pub const SPAN_P2_TILE_ANALYZE: &str = "p2_tile_analyze";
pub const SPAN_P2_INDEX_BUILD: &str = "p2_index_build";
pub const SPAN_P3_MATCH_BATCH: &str = "p3_match_batch";
pub const SPAN_P3_MATCH_TOTAL: &str = "p3_match_total";
pub const SPAN_P4_COMPOSE_BATCH: &str = "p4_compose_batch";
pub const SPAN_P4_COMPOSE_TOTAL: &str = "p4_compose_total";

/// run 開始前の P1/P2 蓄積(begin_run 時に run レコードへ引き取る)。
///
/// P1/P2 は run と非同期に発生する(main 画像の設定・タイルの追加)ため、
/// 「最後の run 完了後からの蓄積」を 1 回分の待ち合わせデータとして保持し、
/// 次の run のレコードに引き渡す。複数 run が発生する間に複数回の
/// set_main_image があっても区別しない(最新状態のみを記録する方針:
/// 進捗の「要求の合流」の考え方と同じ)
#[derive(Clone, Copy, Debug, Default)]
pub struct PendingP1P2 {
    /// P1 の合計 ms(グリッド計算 + ブロック特徴量)
    pub p1_grid_ms: f64,
    pub p1_block_features_ms: f64,
    /// P2: タイル 1 枚あたりの解析時間(累計・最大・平均)
    pub p2_tile_analyze: SpanAgg,
    /// 最後にレコードを引き取ってからの解析タイル数
    pub p2_tile_count: u32,
}

impl PendingP1P2 {
    /// 全量が 0(未計測・未発生)か
    pub fn is_empty(&self) -> bool {
        self.p1_grid_ms == 0.0
            && self.p1_block_features_ms == 0.0
            && self.p2_tile_analyze.count == 0
            && self.p2_tile_count == 0
    }
}

/// 1 回の run(P3 + P4)のメトリクス(handoff/05 §4 の runs[] 1 行)。
///
/// - P1/P2 は前回 run 完了後の蓄積値(since the last run)
/// - P3/P4 は run 実行中の実測値(バッチ境界のスパン累積)
/// - `counter` (batches / tiles) はフェーズ内の実行回数
#[derive(Clone, Debug, Default)]
pub struct RunRecord {
    pub run_id: u32,
    /// 生成トリガー(initial / block_size_change / tile_added / tile_removed /
    /// rerun / rematch)
    pub trigger: String,
    /// run 開始時刻(ホスト時計の値。時計なしは 0.0)
    pub started_at_ms: f64,
    // --- P1 / P2 (前回 run 後の蓄積) ---
    pub p1_grid_ms: f64,
    pub p1_block_features_ms: f64,
    pub p2_tile_analyze_ms: f64,
    pub p2_tile_max_ms: f64,
    pub p2_tile_avg_ms: f64,
    pub p2_tiles: u32,
    /// k-d 木構築の状態(セッション累積。構築は変更時のみに行われる。詳細設計書 4.5)
    pub p2_index_build: SpanAgg,
    // --- P3 / P4 (run 内実測) ---
    pub p3_match_batch: SpanAgg,
    pub p3_match_total_ms: f64,
    pub p4_compose_batch: SpanAgg,
    pub p4_compose_total_ms: f64,
    /// メモリ: タイル合成サムネイル合計バイト数(run 完了時点)
    pub tiles_bytes: u64,
    /// 設定スナップショット(どの閾値のときの数字かを失くさない)
    pub block_size_px: u32,
    pub w_c: f32,
    pub w_d: f32,
    pub usage_penalty: f32,
    pub neighbor_penalty: f32,
    pub color_correct: f32,
    pub row_batch: u32,
}

/// グローバル計測セッション(完成した run レコードの履歴)。
/// 直近 16 run にロールオーバする(メモリ上限の防護)
#[derive(Debug, Default)]
pub struct Metrics {
    core_version: &'static str,
    next_run_id: u32,
    runs: VecDeque<RunRecord>,
}

const MAX_RUN_RECORDS: usize = 16;

impl Metrics {
    /// 直近の run レコード履歴を JSON 文字列として出力する。
    ///
    /// スキーマは handoff/05 §4(getMetrics() の出力)。時間値はミリ秒。
    /// 時時計が未注入の場合は時間値が 0 になる(回数・bytes はそれでも意味がある)。
    /// `started_at_ms` はホスト時計の絶対値(expected: `performance.timeOrigin` +
    /// performance.now() はミリ秒基準)。
    pub fn to_json_string(&self) -> String {
        let mut json = String::with_capacity(512);
        json.push_str("{\"core_version\":\"");
        json.push_str(self.core_version);
        json.push_str("\",\"runs\":[");
        for (i, run) in self.runs.iter().enumerate() {
            if i > 0 {
                json.push(',');
            }
            json.push_str(&format_run_json(run));
        }
        json.push_str("]}");
        json
    }

    /// 履歴に run レコードを追加する(上限でロールオーバ)
    fn push_run(&mut self, record: RunRecord) {
        while self.runs.len() >= MAX_RUN_RECORDS {
            self.runs.pop_front();
        }
        self.runs.push_back(record);
    }

    /// 新しい run_id を採番する
    fn allocate_run_id(&mut self) -> u32 {
        self.next_run_id = self.next_run_id.saturating_add(1);
        self.next_run_id
    }
}

pub(crate) fn with_metrics<R>(f: impl FnOnce(&mut Metrics) -> R) -> R {
    METRICS.with(|cell| f(&mut cell.borrow_mut()))
}

thread_local! {
    static METRICS: RefCell<Metrics> = RefCell::new(Metrics {
        core_version: env!("CARGO_PKG_VERSION"),
        ..Metrics::default()
    });
}

/// メトリクス履歴全体の JSON を返す(getMetrics() 相当: handoff/05 §4)
pub fn export_json() -> String {
    with_metrics(|metrics| metrics.to_json_string())
}

/// run レコードを履歴へ追加する(直近 16 レコードにロールオーバ)
pub fn push_run_record(record: RunRecord) {
    with_metrics(|metrics| metrics.push_run(record));
}

/// run_id を採番する
pub fn allocate_run_id() -> u32 {
    with_metrics(Metrics::allocate_run_id)
}

/// メトリクス JSON の 1 run 部分を出力する(handoff/05 §4 スキーマ準拠)
fn format_run_json(run: &RunRecord) -> String {
    let mut json = String::with_capacity(400);
    json.push_str("{\"run_id\":");
    json.push_str(&run.run_id.to_string());
    json.push_str(",\"trigger\":\"");
    json.push_str(&escape_json(&run.trigger));
    json.push_str("\",\"started_at_ms\":");
    json.push_str(&format!("{:.0}", run.started_at_ms));

    json.push_str(",\"phases\":{");
    let mut parts: Vec<String> = Vec::with_capacity(4);
    parts.push(format!(
        "\"P1_MAIN_ANALYZE\":{{\"ms\":{:.1}}}",
        run.p1_grid_ms + run.p1_block_features_ms
    ));
    parts.push(format!(
        "\"P2_TILE_ANALYZE\":{{\"ms\":{:.1},\"tiles\":{}}}",
        run.p2_tile_analyze_ms, run.p2_tiles
    ));
    parts.push(format!(
        "\"P3_MATCH\":{{\"ms\":{:.1},\"batches\":{}}}",
        run.p3_match_total_ms, run.p3_match_batch.count
    ));
    parts.push(format!(
        "\"P4_COMPOSE\":{{\"ms\":{:.1},\"batches\":{}}}",
        run.p4_compose_total_ms, run.p4_compose_batch.count
    ));
    json.push_str(&parts.join(","));
    json.push('}');

    json.push_str(",\"spans\":{");
    let mut spans: Vec<String> = Vec::new();
    push_span_json(&mut spans, SPAN_P1_GRID, run.p1_grid_ms, 1);
    push_span_json(
        &mut spans,
        SPAN_P1_BLOCK_FEATURES,
        run.p1_block_features_ms,
        1,
    );
    if run.p2_tiles > 0 {
        spans.push(format!(
            "\"{SPAN_P2_TILE_ANALYZE}\":{{\"count\":{},\"avg_ms\":{:.3},\"max_ms\":{:.3}}}",
            run.p2_tiles, run.p2_tile_avg_ms, run.p2_tile_max_ms
        ));
    }
    if run.p2_index_build.count > 0 {
        spans.push(format!(
            "\"{SPAN_P2_INDEX_BUILD}\":{{\"count\":{},\"avg_ms\":{:.3},\"max_ms\":{:.3}}}",
            run.p2_index_build.count,
            run.p2_index_build.avg_ms(),
            run.p2_index_build.max_ms
        ));
    }
    if run.p3_match_batch.count > 0 {
        spans.push(format!(
            "\"{SPAN_P3_MATCH_BATCH}\":{{\"count\":{},\"avg_ms\":{:.3},\"max_ms\":{:.3}}}",
            run.p3_match_batch.count,
            run.p3_match_batch.avg_ms(),
            run.p3_match_batch.max_ms
        ));
    }
    if run.p4_compose_batch.count > 0 {
        spans.push(format!(
            "\"{SPAN_P4_COMPOSE_BATCH}\":{{\"count\":{},\"avg_ms\":{:.3},\"max_ms\":{:.3}}}",
            run.p4_compose_batch.count,
            run.p4_compose_batch.avg_ms(),
            run.p4_compose_batch.max_ms
        ));
    }
    json.push_str(&spans.join(","));
    json.push('}');

    json.push_str(",\"memory\":{\"wasm_heap_bytes\":0,\"tiles_bytes\":");
    json.push_str(&run.tiles_bytes.to_string());
    json.push('}');

    json.push_str(",\"config\":{\"block_size\":");
    json.push_str(&run.block_size_px.to_string());
    let numeric = [
        ("w_c", run.w_c),
        ("w_d", run.w_d),
        ("alpha", run.color_correct),
        ("row_batch", run.row_batch as f32),
    ];
    for (key, value) in &numeric {
        json.push_str(&format!(",\"{key}\":{value:.3}"));
    }
    json.push('}');

    json.push('}');
    json
}

fn push_span_json(spans: &mut Vec<String>, key: &str, ms: f64, count: u32) {
    if ms > 0.0 {
        spans.push(format!(
            "\"{key}\":{{\"count\":{count},\"avg_ms\":{ms:.3},\"max_ms\":{ms:.3}}}"
        ));
    }
}

/// 最小限の JSON 文字列エスケープ(文言に `"`/`\` が入る可能性に対応)
fn escape_json(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            _ => escaped.push(c),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn span_agg_accumulates_count_total_and_max() {
        let mut span = SpanAgg::default();
        span.record(10.0);
        span.record(30.0);
        span.record(20.0);
        assert_eq!(span.count, 3);
        assert!((span.total_ms - 60.0).abs() < 1e-9);
        assert_eq!(span.max_ms, 30.0);
        assert!((span.avg_ms() - 20.0).abs() < 1e-9);
        // 負値は無視
        span.record(-5.0);
        assert_eq!(span.count, 3);
    }

    #[test]
    fn span_agg_without_clock_records_zero() {
        // 時計未注入の now_ms は 0(スパンは回数のみ記録される)
        assert_eq!(now_ms(), 0.0);
        let mut span = SpanAgg::default();
        span.record(now_ms());
        assert_eq!(span.count, 1);
        assert_eq!(span.total_ms, 0.0);
    }

    #[test]
    fn run_json_matches_schema() {
        let record = RunRecord {
            run_id: 3,
            trigger: "initial".to_string(),
            started_at_ms: 1234.0,
            p1_grid_ms: 1.0,
            p1_block_features_ms: 211.4,
            p2_tile_analyze_ms: 168.9,
            p2_tile_max_ms: 5.0,
            p2_tile_avg_ms: 1.13,
            p2_tiles: 300,
            p2_index_build: SpanAgg::default(),
            p3_match_batch: SpanAgg {
                count: 16,
                total_ms: 812.3,
                max_ms: 71.2,
            },
            p3_match_total_ms: 812.3,
            p4_compose_batch: SpanAgg {
                count: 16,
                total_ms: 655.0,
                max_ms: 45.6,
            },
            p4_compose_total_ms: 655.0,
            tiles_bytes: 19_660_800,
            block_size_px: 24,
            w_c: 1.0,
            w_d: 0.25,
            usage_penalty: 0.35,
            neighbor_penalty: 0.5,
            color_correct: 0.7,
            row_batch: 8,
        };
        push_run_record(record);
        let json = with_metrics(|m| m.to_json_string());
        // 代表的な部分の検索(schema 形式・run_id とフェーズの欄)
        assert!(json.contains("\"core_version\""));
        assert!(json.contains("\"run_id\":3"));
        assert!(json.contains("\"trigger\":\"initial\""));
        assert!(json.contains("\"P1_MAIN_ANALYZE\":{\"ms\":212.4}"));
        assert!(json.contains("\"P2_TILE_ANALYZE\":{\"ms\":168.9,\"tiles\":300}"));
        assert!(json.contains("\"P3_MATCH\":{\"ms\":812.3,\"batches\":16}"));
        assert!(json.contains("\"P4_COMPOSE\":{\"ms\":655.0,\"batches\":16}"));
        assert!(
            json.contains("\"p3_match_batch\":"),
            "batch span must be in json"
        );
        assert!(json.contains("\"tiles_bytes\":19660800"));
        assert!(json.contains("\"alpha\":0.700"));
    }

    #[test]
    fn run_records_roll_over_at_cap() {
        with_metrics(|metrics| {
            metrics.next_run_id = 0;
            for _ in 0..MAX_RUN_RECORDS + 5 {
                metrics.allocate_run_id();
                metrics.push_run(RunRecord::default());
            }
            assert_eq!(metrics.runs.len(), MAX_RUN_RECORDS);
            // 古いもの(先頭)が脱落し、直近 MAX レコードが残る
        });
        with_metrics(|m| m.to_json_string());
    }

    #[test]
    fn install_clock_swaps_and_feeds_now_ms() {
        install_clock(Box::new(|| 42.0));
        assert_eq!(now_ms(), 42.0);
        install_clock(Box::new(|| 100.0));
        assert_eq!(now_ms(), 100.0);
        // テスト後の後始末(他テストに影響しないように既定に戻す)
        CLOCK.with(|clock| {
            *clock.borrow_mut() = None;
        });
    }
}
