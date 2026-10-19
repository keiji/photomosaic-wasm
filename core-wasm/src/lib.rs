//! コアの WASM バインディング(wasm-bindgen)。
//!
//! 薄い層の方針(詳細設計書 1.2): メモリ受け渡しとコールバック変換のみを担い、
//! アルゴリズムは [`photomosaic_core`](photomosaic_core) クレートに置く。
//! FFI(unsafe)はこのクレートには出さず、wasm-bindgen の安全な抽象のみを使う。

use photomosaic_core::color::lab_to_srgb8;
use photomosaic_core::config::MosaicConfig;
use photomosaic_core::grid::{
    compute_block_features, compute_grid_info, BlockFeature, GridInfo, DEFAULT_BLOCK_SIZE,
};
use photomosaic_core::metrics::{self, PendingP1P2, RunRecord, SpanAgg};
use photomosaic_core::pipeline::{self, MatchMode};
use photomosaic_core::progress::ProgressEvent;
use photomosaic_core::tile::{TileFeature, TilePool};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

/// コアのスパン計測にホスト時計を注入する(M7: handoff/05 §2)。
///
/// `globalThis.performance.now()`(単調)を用い、無ければ `Date.now()`
/// (サンドボックス環境のフォールバック)。コア内部は時計を持たない
fn install_panic_hook() {
    // パニックの可視化(開発補助): コンソールへ panic メッセージを出す
    std::panic::set_hook(Box::new(|info| {
        let console = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("console"));
        let console = console.ok().filter(|c| c.is_object());
        if let Some(console) = console {
            let error = js_sys::Reflect::get(&console, &JsValue::from_str("error"));
            if let Ok(error) = error {
                if error.is_function() {
                    let f: js_sys::Function = error.dyn_into().expect("checked is_function");
                    let _ = f.call1(&console, &JsValue::from_str(&format!("{info}")));
                }
            }
        }
    }));
}

#[wasm_bindgen(start)]
pub fn boot() {
    install_panic_hook();
    metrics::install_clock(Box::new(|| {
        let global = js_sys::global();
        let performance = js_sys::Reflect::get(&global, &JsValue::from_str("performance"));
        let now_fn = performance.and_then(|performance| {
            if !performance.is_object() {
                return Err(JsValue::from_str("no performance"));
            }
            let result = js_sys::Reflect::get(&performance, &JsValue::from_str("now"));
            if let Ok(now) = result {
                if now.is_function() {
                    let now: js_sys::Function = now.dyn_into().expect("checked is_function");
                    let ms = now.call0(&performance);
                    if let Ok(ms) = ms
                        .and_then(|ms| ms.as_f64().ok_or_else(|| JsValue::from_str("not a number")))
                    {
                        return Ok(ms);
                    }
                }
            }
            Err(JsValue::from_str("no performance.now"))
        });
        now_fn.ok().unwrap_or_else(js_sys::Date::now)
    }));
}

/// P1/P2 の蓄積と run レコードの進行情報(M7 計測の常時化)。
///
/// - `pending`: 最後の run 完了以降の P1 グリッド・特徴量と P2 タイル解析の蓄積
/// - `trigger`: 直近の状態変更(main 設定・ブロックサイズ変更・タイル追加/削除)。
///   次の begin_run / begin_rematch の trigger になり、採番後は消費する
struct MetricsSession {
    pending: PendingP1P2,
    /// 直近の状態変更の種別(次の run の trigger)
    trigger: Option<&'static str>,
    /// 実行中の run レコード(begin 時に作成、完了時に P3/P4 へ埋めて推送)
    active_record: Option<RunRecord>,
}

impl MetricsSession {
    /// 既定の進行情報(蓄積は発生時に埋まる)
    fn new() -> Self {
        MetricsSession {
            pending: PendingP1P2::default(),
            trigger: None,
            active_record: None,
        }
    }
}

/// コア内に保持するメイン画像の状態(詳細設計書 9 章のメモリ設計に基づき、
/// 解析・出力用の RGBA をコア内に保持する。exportImage で 1 回だけ取り出す)。
struct MainImageState {
    rgba: Vec<u8>,
    grid: GridInfo,
    features: Vec<BlockFeature>,
    /// 現在の割当表(全ブロック分。None = 未確定。M6 差分再マッチの基礎)。
    /// run 中は実行状態へ移動し、完了・キャンセル時に確定済み分が戻る
    assigned: Vec<Option<u64>>,
    /// 現在の割当表の計算後にタイルが追加されたか(差し替え評価の要否。M6)
    tiles_added_since_match: bool,
    /// P4 合成結果(run 後に設定。exportImage の対象となる)
    composed: Option<Vec<u8>>,
    /// 進行中の行バッチ実行(M5: begin_run で開始、step_run で駆動)
    run: Option<pipeline::BatchRunState>,
}

thread_local! {
    // WASM はシングルスレッドで動く(詳細設計書 8.1)ため thread_local + RefCell で十分
    static MAIN_IMAGE: RefCell<Option<MainImageState>> = const { RefCell::new(None) };

    /// タイルプール(P2 で解析したタイルの集合。P4 合成用サムネイルも保持)
    static TILE_POOL: RefCell<TilePool> = RefCell::new(TilePool::new());

    /// マッチング・合成のパラメータ(詳細設計書 5 章。setConfig で上書き)
    static CONFIG: RefCell<MosaicConfig> = RefCell::new(MosaicConfig::default());

    /// メトリクスの進行情報(M7: 計測の常時化。handoff/05 §2)
    static METRICS_SESSION: RefCell<MetricsSession> = RefCell::new(MetricsSession::new());
}

/// JS 例外(Error インスタンス)を生成する。
/// 文字列を直接投げると JS 側のテスト・エラー処理で扱いにくいため、
/// エラーは必ず Error インスタンスとして伝播させる。
fn js_error(message: &str) -> JsValue {
    js_sys::Error::new(message).into()
}

/// u32 → usize の変換(wasm32 でも 4 GB 未満の寸法を安全に扱う)
fn to_usize(value: u32) -> usize {
    usize::try_from(value).expect("value fits usize")
}

// --- メトリクスの結線(M7: handoff/05 性能の計測設計) ---

/// P1 のスパンを蓄積する(span_id は metrics.rs の定数: handoff/05 §3)
fn record_p1_span(span_id: &'static str, ms: f64) {
    METRICS_SESSION.with(|session| {
        let mut session = session.borrow_mut();
        if span_id == metrics::SPAN_P1_GRID {
            session.pending.p1_grid_ms += ms;
        } else if span_id == metrics::SPAN_P1_BLOCK_FEATURES {
            session.pending.p1_block_features_ms += ms;
        }
    });
}

/// P2 のスパン(タイル 1 枚の解析)を蓄積する
fn record_p2_tile_span(ms: f64) {
    METRICS_SESSION.with(|session| {
        let mut session = session.borrow_mut();
        session.pending.p2_tile_analyze.record(ms);
        session.pending.p2_tile_count += 1;
    });
}

/// 直近の状態変更を trigger として記録する(次の run で採用・消費)
fn mark_trigger(trigger: &'static str) {
    METRICS_SESSION.with(|session| {
        session.borrow_mut().trigger = Some(trigger);
    });
}

/// run の開始をメトリクスへ記録する(P1/P2 の蓄積を引き取ったうえで新規レコード)
fn begin_run_record(block_size_px: u32, config: &MosaicConfig, tiles_bytes: u64) {
    METRICS_SESSION.with(|session| {
        let mut session = session.borrow_mut();
        let trigger = session.trigger.take();
        let pending = session.pending;
        session.pending = PendingP1P2::default();
        let record = RunRecord {
            run_id: metrics::allocate_run_id(),
            trigger: match trigger {
                Some(value) => value.to_owned(),
                None => "rematch".to_owned(),
            },
            started_at_ms: metrics::now_ms(),
            p1_grid_ms: pending.p1_grid_ms,
            p1_block_features_ms: pending.p1_block_features_ms,
            p2_tile_analyze_ms: pending.p2_tile_analyze.total_ms,
            p2_tile_max_ms: pending.p2_tile_analyze.max_ms,
            p2_tile_avg_ms: pending.p2_tile_analyze.avg_ms(),
            p2_tiles: pending.p2_tile_count,
            p2_index_build: SpanAgg::default(),
            p3_match_batch: SpanAgg::default(),
            p3_match_total_ms: 0.0,
            p4_compose_batch: SpanAgg::default(),
            p4_compose_total_ms: 0.0,
            tiles_bytes,
            block_size_px,
            w_c: config.w_c,
            w_d: config.w_d,
            usage_penalty: config.usage_penalty,
            neighbor_penalty: config.neighbor_penalty,
            duplicate_de: config.duplicate_de,
            duplicate_detail: config.duplicate_detail,
            color_correct: config.color_correct,
            row_batch: config.row_batch,
        };
        session.active_record = Some(record);
    });
}

/// run の完了(またはキャンセル)でメトリクスに確定値を推送する。
///
/// - `spans`: パイプラインの実測(P3/P4 バッチ所要)
/// - k-d 木構築はセッション累積(構築は変更時にのみ発生するため)
fn finish_run_record(spans: pipeline::RunSpans) {
    let pool_stats = TILE_POOL.with(|cell| cell.borrow().index_build_stats());
    let tiles_bytes = TILE_POOL.with(|cell| cell.borrow().total_compose_bytes());
    METRICS_SESSION.with(|session| {
        let mut session = session.borrow_mut();
        if let Some(mut record) = session.active_record.take() {
            record.p3_match_batch = spans.p3_match_batch;
            record.p3_match_total_ms = spans.p3_match_batch.total_ms;
            record.p4_compose_batch = spans.p4_compose_batch;
            record.p4_compose_total_ms = spans.p4_compose_batch.total_ms;
            record.p2_index_build = pool_stats;
            record.tiles_bytes = tiles_bytes;
            metrics::push_run_record(record);
        }
    });
}

/// メトリクス JSON を返す(M7: handoff/05 §4 getMetrics() の出力)。
///
/// 直近 16 run の分(run_id・trigger・フェーズ所要・バッチスパン・メモリ・
/// 設定スナップショット)。UI オーバーレイやベンチでの記録に使用する。
/// 時計が流せる環境では時間値が実測される(コアは時計を持たない)
#[wasm_bindgen]
pub fn get_metrics() -> String {
    metrics::export_json()
}

/// コアバージョン(Web と Android で同一の .wasm を使うための整合確認用)
#[wasm_bindgen]
pub fn get_version() -> String {
    format!("photomosaic-core {}", photomosaic_core::CORE_VERSION)
}

/// 値の往復サンプル(handoff/02 検収基準: サンプル関数を JS から呼び値が往復すること)
#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// グリッド情報(詳細設計書 3 章 GridInfo の JS 輸出)
#[wasm_bindgen]
pub struct JsGridInfo {
    width: u32,
    height: u32,
    block_size: u32,
    cols: u32,
    rows: u32,
    total_blocks: u32,
}

impl JsGridInfo {
    fn from_grid(grid: GridInfo) -> JsGridInfo {
        JsGridInfo {
            width: grid.width,
            height: grid.height,
            block_size: grid.block_size,
            cols: grid.cols,
            rows: grid.rows,
            total_blocks: grid.total_blocks,
        }
    }
}

#[wasm_bindgen]
impl JsGridInfo {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[wasm_bindgen(getter)]
    pub fn block_size(&self) -> u32 {
        self.block_size
    }

    #[wasm_bindgen(getter)]
    pub fn cols(&self) -> u32 {
        self.cols
    }

    #[wasm_bindgen(getter)]
    pub fn rows(&self) -> u32 {
        self.rows
    }

    #[wasm_bindgen(getter)]
    pub fn total_blocks(&self) -> u32 {
        self.total_blocks
    }
}

/// P1 メイン画像解析: グリッド計算とブロック特徴量を計算し、コア内に保持する。
///
/// `rgba` は R→G→B→A 順・行優先・非プリマルチプライ・sRGB の 1 ピクセル 4 バイト。
/// ブロックサイズはコア既定値(24px)で計算し、変更は [`set_block_size`] で行う。
#[wasm_bindgen]
pub fn set_main_image(rgba: Vec<u8>, width: u32, height: u32) -> Result<JsGridInfo, JsValue> {
    let pixel_count = usize::try_from(
        width
            .checked_mul(height)
            .ok_or_else(|| js_error("image size overflow"))?,
    )
    .map_err(|_| js_error("image size overflow"))?;
    if rgba.len() != pixel_count * 4 {
        return Err(js_error("rgba buffer length mismatch"));
    }

    // P1 のスパン計測(M7: handoff/05 §3 p1_grid / p1_block_features)
    let t0 = metrics::now_ms();
    let grid = compute_grid_info(width, height, DEFAULT_BLOCK_SIZE);
    let grid_ms = metrics::now_ms() - t0;
    let t1 = metrics::now_ms();
    let features = compute_block_features(&rgba, width, height, DEFAULT_BLOCK_SIZE);
    let features_ms = metrics::now_ms() - t1;
    record_p1_span(metrics::SPAN_P1_GRID, grid_ms);
    record_p1_span(metrics::SPAN_P1_BLOCK_FEATURES, features_ms);
    mark_trigger("initial");

    MAIN_IMAGE.with(|cell| {
        *cell.borrow_mut() = Some(MainImageState {
            rgba,
            grid,
            features,
            assigned: Vec::new(),
            tiles_added_since_match: false,
            composed: None,
            run: None,
        });
    });

    Ok(JsGridInfo::from_grid(grid))
}

/// P1 再実行: ブロックサイズを変更してグリッド・ブロック特徴量を再計算する
///
/// 基本設計書 3.3: グリッド再計算 → 全ブロック再マッチ → 再合成。
/// タイル特徴量はブロックサイズに依存しないため P2 は再実行しない(キャッシュ再利用)。
/// 割当表は全ブロック未確定に戻る(次の run で全ブロック再マッチになる)
#[wasm_bindgen]
pub fn set_block_size(px: u32) -> Result<JsGridInfo, JsValue> {
    if px == 0 {
        return Err(js_error("block size must be positive"));
    }
    MAIN_IMAGE.with(|cell| -> Result<JsGridInfo, JsValue> {
        let mut state = cell.borrow_mut();
        let Some(main) = state.as_mut() else {
            return Err(js_error("main image is not set"));
        };
        let width = main.grid.width;
        let height = main.grid.height;
        // P1 再計算のスパン計測(M7)
        let t0 = metrics::now_ms();
        main.grid = compute_grid_info(width, height, px);
        let grid_ms = metrics::now_ms() - t0;
        let t1 = metrics::now_ms();
        main.features = compute_block_features(&main.rgba, width, height, px);
        let features_ms = metrics::now_ms() - t1;
        record_p1_span(metrics::SPAN_P1_GRID, grid_ms);
        record_p1_span(metrics::SPAN_P1_BLOCK_FEATURES, features_ms);
        mark_trigger("block_size_change");
        // ブロックサイズ変更でグリッドが変わるため、既存の割当表・合成結果は
        // 無効化する(全ブロックが未確定。生成は再度 run で行う)
        main.assigned = Vec::new();
        main.tiles_added_since_match = false;
        main.composed = None;
        // 進行中の行バッチ実行もグリッドと不整合になるため破棄する
        main.run = None;
        Ok(JsGridInfo::from_grid(main.grid))
    })
}

/// プレビュー描画用のブロック平均色を返す。
///
/// 各ブロックの mean_lab(CIELAB)を sRGB 8bit へ逆変換し、
/// RGB 3 バイト × ブロック数(行優先)のバイト列として返す。
/// メイン画像未設定時は空の配列を返す(論理 API の契約)。
#[wasm_bindgen]
pub fn get_block_mean_colors() -> Result<Vec<u8>, JsValue> {
    MAIN_IMAGE.with(|cell| {
        let binding = cell.borrow();
        let Some(main) = binding.as_ref() else {
            return Ok(Vec::new());
        };
        let mut colors = Vec::with_capacity(main.features.len() * 3);
        for feature in &main.features {
            let [r, g, b] = lab_to_srgb8(
                f64::from(feature.mean_lab[0]),
                f64::from(feature.mean_lab[1]),
                f64::from(feature.mean_lab[2]),
            );
            colors.extend_from_slice(&[r, g, b]);
        }
        Ok(colors)
    })
}

/// 現時点の完成画像(または解析対象のメイン画像)RGBA を返す(P5 のエンコード前段)。
/// run 済みの場合は P4 合成結果を、未実行の場合は正規化後のメイン画像を返す
/// (詳細設計書 2 章 exportImage: 「完成画像(または現時点までの合成結果)」)。
#[wasm_bindgen]
pub fn export_main_image() -> Result<Vec<u8>, JsValue> {
    MAIN_IMAGE.with(|cell| {
        let binding = cell.borrow();
        let Some(main) = binding.as_ref() else {
            return Err(js_error("main image is not set"));
        };
        Ok(main.composed.as_ref().unwrap_or(&main.rgba).clone())
    })
}

/// フォトモザイクの P3(マッチング)+ P4(合成)を開始する(M5)。
///
/// - メイン画像未設定・タイルプール空の場合はエラー(詳細設計書 6 章:
///   タイルプール空での run は実行せず UI 層で案内する)
/// - 実行は行バッチ(row_batch 行)単位で進む。ホストは [`step_run`] を
///   完了まで繰り返し呼び出し、バッチ境界で JS へ制御を返して
///   UI 更新・進捗表示・部分描画を介在させる(詳細設計書 8.1)
/// - 使用回数 usage は開始時に正規化する(M4 と同一挙動)。
///   差分再マッチ([`begin_rematch`])とは異なり全ブロックを再マッチする
/// - 進行中の別 run があれば破棄して新しく開始する
#[wasm_bindgen]
pub fn begin_run() -> Result<(), JsValue> {
    let has_main = MAIN_IMAGE.with(|cell| cell.borrow().is_some());
    if !has_main {
        return Err(js_error("main image is not set"));
    }
    let tile_count = TILE_POOL.with(|cell| cell.borrow().tile_count());
    if tile_count == 0 {
        return Err(js_error("tile pool is empty"));
    }
    TILE_POOL.with(|cell| cell.borrow_mut().reset_usage());
    MAIN_IMAGE.with(|cell| {
        let mut state = cell.borrow_mut();
        if let Some(main) = state.as_mut() {
            // 新しい run が旧合成結果を無効化することを確定させ(基本設計書 3.3)、
            // 行シードとの二重確保(最大 ~128 MB+64 MB)を避けてから実行状態を作る。
            // 割当表は実行状態へ移管し(全ブロック未確定で開始)、
            // 完了・キャンセル時に確定済み分が戻る
            main.composed = None;
            main.tiles_added_since_match = false;
            main.assigned = Vec::new();
            main.run = Some(pipeline::BatchRunState::new(
                main.grid,
                &main.features,
                &main.rgba,
            ));
            // メトリクス: run レコードの開始を記録する(M7: handoff/05 §4)
            let config = CONFIG.with(|config| *config.borrow());
            let tiles_bytes = TILE_POOL.with(|pool| pool.borrow().total_compose_bytes());
            begin_run_record(main.grid.block_size, &config, tiles_bytes);
        }
    });
    Ok(())
}

/// 差分再マッチを開始する(M6: 詳細設計書 4.4 差分再マッチ / 7.5 要求の合流)。
///
/// 現在の割当表とタイルプールの状態からモードを決定する:
///
/// - 割当表が空(初回生成・ブロックサイズ変更後)→ 全ブロックをマッチする
///   ([`begin_run`] と同一。未確定ブロック = 全ブロック)
/// - 未確定ブロックがある(タイル追加・削除後)→ 未確定ブロックのみマッチする
/// - 全ブロック確定済みでタイルが追加された → 差し替え評価のみ行う
///   (現割当より `improve_margin` 以上良い候補がある場合に差し替える)
/// - 再マッチ不要(未確定なし・追加なし)→ 何もせず即時に完了する
///
/// 使用回数 usage は開始時・完了時に現割当表から再集計する(4.4:
/// 「ペナルティの連続性を保つ」)。進捗・部分結果は run と同一の
/// [`step_run`] 駆動で得られる(差分再マッチも P3 として計上)
#[wasm_bindgen]
pub fn begin_rematch() -> Result<(), JsValue> {
    let has_main = MAIN_IMAGE.with(|cell| cell.borrow().is_some());
    if !has_main {
        return Err(js_error("main image is not set"));
    }
    let tile_count = TILE_POOL.with(|cell| cell.borrow().tile_count());
    if tile_count == 0 {
        return Err(js_error("tile pool is empty"));
    }

    MAIN_IMAGE.with(|cell| -> Result<(), JsValue> {
        let mut state = cell.borrow_mut();
        let Some(main) = state.as_mut() else {
            return Err(js_error("main image is not set"));
        };
        // 差分モードの決定(詳細設計書 4.4)。
        // タイル追加のフラグは開始した再マッチで消費する(要求の合流:
        // 蓄積した変更は最新状態の 1 回の再開で吸収する。詳細設計書 7.5)
        let total_blocks = main.grid.total_blocks;
        let (mode, rematch_needed, assigned) = if main.assigned.is_empty() {
            // 未確定 = 全ブロック: フルマッチと同一(usage は正規化する)
            TILE_POOL.with(|pool| pool.borrow_mut().reset_usage());
            (MatchMode::Full, true, vec![None; to_usize(total_blocks)])
        } else if main.assigned.iter().any(Option::is_none) {
            // 未確定ブロックのみマッチする(タイル追加・削除後)
            (
                MatchMode::FillUnmatched,
                true,
                std::mem::take(&mut main.assigned),
            )
        } else if main.tiles_added_since_match {
            // 全ブロック確定済み + タイル追加: 差し替え評価のみ
            (
                MatchMode::SwapEvaluate,
                true,
                std::mem::take(&mut main.assigned),
            )
        } else {
            // 再マッチ不要(タイル削除の対象ブロックなし等)。
            // 即時に完了する実行状態を作り、呼び出し側の step ループを成立させる
            (
                MatchMode::FillUnmatched,
                false,
                std::mem::take(&mut main.assigned),
            )
        };
        main.tiles_added_since_match = false;
        if rematch_needed {
            // 使用回数を現割当表から再集計する(4.4: ペナルティの連続性を保つ)。
            // mem::take 後の main.assigned は空のため、取り出した現割当表(assigned)を
            // 渡す(空表を渡すと差分再マッチのたびに usage がゼロリセットされ、
            // 使用ペナルティの連続性が失われる)
            TILE_POOL.with(|pool| {
                pool.borrow_mut().recount_usage(&assigned);
            });
        }
        // 出力バッファのシードは現時点の合成結果(差分はこの上に上書き)。
        // 合成結果が無い場合はメイン画像(全行が未合成相当)
        let seed = main.composed.take().unwrap_or_else(|| main.rgba.clone());
        main.run = Some(pipeline::BatchRunState::new_rematch(
            main.grid,
            &main.features,
            assigned,
            &seed,
            mode,
        ));
        // メトリクス: run レコードの開始を記録する(M7)
        let config = CONFIG.with(|config| *config.borrow());
        let tiles_bytes = TILE_POOL.with(|pool| pool.borrow().total_compose_bytes());
        begin_run_record(main.grid.block_size, &config, tiles_bytes);
        Ok(())
    })
}

/// フォトモザイクの実行を 1 行バッチぶん進める(M5)。
///
/// - `now_ms` はホストの時刻(起点は不問)。コア内部のスロットリング
///   (16ms 以上または全体進捗 1% 以上の変化で発火。詳細設計書 7.2)に
///   使用する。ダミー時間を用いた決定性テストには `None` や固定値も渡せる
/// - 戻り値はこのバッチで発火した進捗イベントと部分結果(行範囲の RGBA)、
///   および完了フラグ。完了(`done == true`)時は合成結果が内部に確定し、
///   以降 `export_main_image` で取得できる
/// - 進行中の run がない場合はエラーになる
#[wasm_bindgen]
pub fn step_run(now_ms: Option<f64>) -> Result<JsStepOutput, JsValue> {
    let config = CONFIG.with(|cell| *cell.borrow());
    let mut finished_spans: Option<pipeline::RunSpans> = None;
    let output = TILE_POOL.with(|pool_cell| -> Result<JsStepOutput, JsValue> {
        let mut pool = pool_cell.borrow_mut();
        MAIN_IMAGE.with(|image_cell| {
            let mut state = image_cell.borrow_mut();
            let Some(main) = state.as_mut() else {
                return Err(js_error("main image is not set"));
            };
            let Some(run) = main.run.as_mut() else {
                return Err(js_error("run is not started"));
            };
            let step = run.step(&mut pool, &config, now_ms);
            let done = step.done;
            let canceled = run.is_canceled();
            let progress = step.progress.map(JsProgressEvent::from_event);
            let result = step.result.map(JsResultBatch::from_batch);
            if done {
                // 完了(またはキャンセル)で内部状態を確定する。
                // キャンセル時は「現時点までの合成結果」(未完成行はシード)と
                // 確定済みの割当表を保持する
                if let Some(out) = run.take_output() {
                    main.composed = Some(out);
                }
                main.assigned = run.take_assignments();
                // 使用回数を現割当表から再集計する(4.4: 差分再マッチ後に
                // ペナルティの連続性を保つ。フルランでは再計上で同一値)
                pool.recount_usage(&main.assigned);
                // メトリクス用のスパンを取り出す(M7)。
                // push は borrow を解放した後に行う(TILE_POOL の二重借用防止)
                finished_spans = Some(run.take_spans());
                main.run = None;
            }
            Ok(JsStepOutput {
                done,
                canceled,
                progress,
                result,
            })
        })
    })?;
    if let Some(spans) = finished_spans {
        finish_run_record(spans);
    }
    Ok(output)
}

/// フォトモザイクの実行をキャンセルする(詳細設計書 7.5)。
///
/// キャンセルはバッチ境界で効く: 実行中の行バッチは完走したうえで停止する。
/// 既存のマッチ結果と現時点までの合成結果は保持され(exportImage の対象)、
/// 以降の `step_run` はエラーになる(呼び出し側はループを停止する)
#[wasm_bindgen]
pub fn cancel() {
    MAIN_IMAGE.with(|cell| {
        let mut state = cell.borrow_mut();
        if let Some(main) = state.as_mut() {
            if let Some(mut run) = main.run.take() {
                run.cancel();
                if let Some(out) = run.take_output() {
                    main.composed = Some(out);
                }
                // 確定済みの割当表を保持する(M6: 差分再マッチは既存割当を基礎に
                // 続行する。キャンセル分の使用回数も現割当表から再集計する)
                main.assigned = run.take_assignments();
                TILE_POOL.with(|pool| pool.borrow_mut().recount_usage(&main.assigned));
                // メトリクス: キャンセル時点までのスパンを推送する(M7)
                finish_run_record(run.take_spans());
            }
        }
    });
}

/// フォトモザイクのマッチング(P3)+ 合成(P4)を一括実行する(同期 API)。
///
/// 内部では [`begin_run`] + [`step_run`](`None` 時刻)の行バッチ実行を
/// 完走させ、一括実行経路とバッチ実行経路が同一の結果になることを
/// 保証する。進捗イベント・部分結果の通知(M5 の主経路)が必要な場合は
/// begin/step/cancel のペアを使用する
#[wasm_bindgen]
pub fn run() -> Result<(), JsValue> {
    begin_run()?;
    loop {
        if step_run(None)?.done {
            break;
        }
    }
    Ok(())
}

/// 現在の設定(詳細設計書 5 章)を JSON 文字列で返す(詳細設計書 2 章 getConfig)
#[wasm_bindgen]
pub fn get_config() -> Result<String, JsValue> {
    let config = CONFIG.with(|cell| *cell.borrow());
    config_to_json(&config)
}

/// 設定 JSON でパラメータを上書きする(詳細設計書 2 章 setConfig)。
/// すべてのフィールドが必須。詳細設計書 5 章の範囲外はエラーになる
#[wasm_bindgen]
pub fn set_config(json: String) -> Result<(), JsValue> {
    let parsed = js_sys::JSON::parse(&json).map_err(|_| js_error("config JSON is invalid"))?;
    let value = &parsed;
    let f32_field = |key: &str| -> Result<f32, JsValue> {
        js_sys::Reflect::get(value, &key.into())
            .map_err(|_| js_error("config JSON is invalid"))?
            .as_f64()
            .map(|v| v as f32)
            .ok_or_else(|| js_error(&format!("config field '{key}' must be a number")))
    };
    let u32_field = |key: &str| -> Result<u32, JsValue> {
        js_sys::Reflect::get(value, &key.into())
            .map_err(|_| js_error("config JSON is invalid"))?
            .as_f64()
            .and_then(|v| {
                if v >= 0.0 && v.fract() == 0.0 && v <= f64::from(u32::MAX) {
                    Some(v as u32)
                } else {
                    None
                }
            })
            .ok_or_else(|| {
                js_error(&format!(
                    "config field '{key}' must be a non-negative integer"
                ))
            })
    };
    let config = MosaicConfig {
        w_c: f32_field("w_c")?,
        w_d: f32_field("w_d")?,
        usage_penalty: f32_field("usage_penalty")?,
        neighbor_penalty: f32_field("neighbor_penalty")?,
        identical_de: f32_field("identical_de")?,
        improve_margin: f32_field("improve_margin")?,
        duplicate_de: f32_field("duplicate_de")?,
        duplicate_detail: f32_field("duplicate_detail")?,
        usage_cap: u32_field("usage_cap")?,
        color_correct: f32_field("color_correct")?,
        row_batch: u32_field("row_batch")?,
    };
    config
        .validate()
        .map_err(|err| js_error(&err.to_string()))?;
    CONFIG.with(|cell| {
        *cell.borrow_mut() = config;
    });
    Ok(())
}

/// MosaicConfig を JSON オブジェクトへ変換する(get_config 用)。
/// キー名は詳細設計書 5 章のパラメータ名と一致させる
fn config_to_json(config: &MosaicConfig) -> Result<String, JsValue> {
    let obj = js_sys::Object::new();
    let numeric = [
        ("w_c", f64::from(config.w_c)),
        ("w_d", f64::from(config.w_d)),
        ("usage_penalty", f64::from(config.usage_penalty)),
        ("neighbor_penalty", f64::from(config.neighbor_penalty)),
        ("identical_de", f64::from(config.identical_de)),
        ("improve_margin", f64::from(config.improve_margin)),
        ("duplicate_de", f64::from(config.duplicate_de)),
        ("duplicate_detail", f64::from(config.duplicate_detail)),
        ("usage_cap", f64::from(config.usage_cap)),
        ("color_correct", f64::from(config.color_correct)),
        ("row_batch", f64::from(config.row_batch)),
    ];
    for (key, value) in numeric {
        js_sys::Reflect::set(obj.as_ref(), &key.into(), &value.into())
            .map_err(|_| js_error("failed to serialize config"))?;
    }
    js_sys::JSON::stringify(obj.as_ref())
        .map_err(|_| js_error("failed to serialize config"))?
        .as_string()
        .ok_or_else(|| js_error("failed to serialize config"))
}

/// メイン画像の状態を破棄する(リセット操作に対応。大容量バッファを開放する)
#[wasm_bindgen]
pub fn clear_main_image() {
    MAIN_IMAGE.with(|cell| {
        *cell.borrow_mut() = None;
    });
}

/// UI 表示用の進捗イベント(文言は持たず、安定識別子 `phase_code` のみ。詳細設計書 7.2)
#[wasm_bindgen]
pub struct JsProgressEvent {
    phase_code: String,
    phase_ratio: f32,
    overall_ratio: f32,
    assigned_blocks: u32,
    total_blocks: u32,
}

impl JsProgressEvent {
    /// コアの進捗イベントを JS 輸出用へ変換する
    fn from_event(event: ProgressEvent) -> JsProgressEvent {
        JsProgressEvent {
            phase_code: event.phase.code().to_string(),
            phase_ratio: event.phase_ratio,
            overall_ratio: event.overall_ratio,
            assigned_blocks: event.assigned_blocks,
            total_blocks: event.total_blocks,
        }
    }
}

#[wasm_bindgen]
impl JsProgressEvent {
    #[wasm_bindgen(getter)]
    pub fn phase_code(&self) -> String {
        self.phase_code.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn phase_ratio(&self) -> f32 {
        self.phase_ratio
    }

    #[wasm_bindgen(getter)]
    pub fn overall_ratio(&self) -> f32 {
        self.overall_ratio
    }

    #[wasm_bindgen(getter)]
    pub fn assigned_blocks(&self) -> u32 {
        self.assigned_blocks
    }

    #[wasm_bindgen(getter)]
    pub fn total_blocks(&self) -> u32 {
        self.total_blocks
    }
}

/// `step_run` 1 バッチ分の JS 輸出。
///
/// `progress` / `result` は発火があった場合のみ非 `null`。JS 側は未使用の
/// イベント・部分結果オブジェクトを `free()` で解放する(寿命管理)
#[wasm_bindgen]
pub struct JsStepOutput {
    done: bool,
    canceled: bool,
    progress: Option<JsProgressEvent>,
    result: Option<JsResultBatch>,
}

#[wasm_bindgen]
impl JsStepOutput {
    /// 実行が完了(またはキャンセル)した
    #[wasm_bindgen(getter)]
    pub fn done(&self) -> bool {
        self.done
    }

    /// 完了がキャンセルによるもの
    #[wasm_bindgen(getter)]
    pub fn canceled(&self) -> bool {
        self.canceled
    }

    /// 発火した進捗イベント(onProgress スロットリング済み)。
    /// 取り出し後は再度取得できない
    #[wasm_bindgen(getter)]
    pub fn progress(&mut self) -> Option<JsProgressEvent> {
        self.progress.take()
    }

    /// 発火した部分結果(P4 合成バッチ)。取り出し後は再度取得できない
    #[wasm_bindgen(getter)]
    pub fn result(&mut self) -> Option<JsResultBatch> {
        self.result.take()
    }
}

/// 部分結果(詳細設計書 3 章 ResultBatch / 7.4 の JS 輸出)。
///
/// 行番号はブロック行(row_batch の単位)。画素行への写像は
/// `row_begin * block_size`。`rgba` は `width * (row_end - row_begin)
/// * block_size * 4` バイト(下端の半端ブロック行は画像端でクリップ)
#[wasm_bindgen]
pub struct JsResultBatch {
    row_begin: u32,
    row_end: u32,
    block_size: u32,
    width: u32,
    rgba: Vec<u8>,
}

#[wasm_bindgen]
impl JsResultBatch {
    fn from_batch(batch: pipeline::ResultBatch) -> JsResultBatch {
        JsResultBatch {
            row_begin: batch.row_begin,
            row_end: batch.row_end,
            block_size: batch.block_size,
            width: batch.width,
            rgba: batch.rgba,
        }
    }

    /// 完成したブロック行範囲 `[row_begin, row_end)`
    #[wasm_bindgen(getter)]
    pub fn row_begin(&self) -> u32 {
        self.row_begin
    }

    #[wasm_bindgen(getter)]
    pub fn row_end(&self) -> u32 {
        self.row_end
    }

    /// 1 ブロック行の高さ px(画素行への写像に使用)
    #[wasm_bindgen(getter)]
    pub fn block_size(&self) -> u32 {
        self.block_size
    }

    /// 画像幅 px
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// 合成済み RGBA 行バッファ
    #[wasm_bindgen(getter)]
    pub fn rgba(&self) -> Vec<u8> {
        self.rgba.clone()
    }
}

/// タイル情報(詳細設計書 3 章 TileFeature の JS 輸出)
#[wasm_bindgen]
pub struct JsTileInfo {
    id: u64,
    thumb_w: u32,
    thumb_h: u32,
    mean_lab: [f32; 3],
    detail: f32,
    usage: u32,
}

impl JsTileInfo {
    fn from_feature(feature: TileFeature) -> JsTileInfo {
        JsTileInfo {
            id: feature.id,
            thumb_w: feature.thumb_w,
            thumb_h: feature.thumb_h,
            mean_lab: feature.mean_lab,
            detail: feature.detail,
            usage: feature.usage,
        }
    }
}

#[wasm_bindgen]
impl JsTileInfo {
    /// アプリ側が採番したタイル ID(JS では bigint として扱う)
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> u64 {
        self.id
    }

    #[wasm_bindgen(getter)]
    pub fn thumb_w(&self) -> u32 {
        self.thumb_w
    }

    #[wasm_bindgen(getter)]
    pub fn thumb_h(&self) -> u32 {
        self.thumb_h
    }

    /// CIELAB 平均 (L*, a*, b*)
    #[wasm_bindgen(getter)]
    pub fn mean_lab(&self) -> Vec<f32> {
        self.mean_lab.to_vec()
    }

    #[wasm_bindgen(getter)]
    pub fn detail(&self) -> f32 {
        self.detail
    }

    #[wasm_bindgen(getter)]
    pub fn usage(&self) -> u32 {
        self.usage
    }
}

/// P2 タイル解析: タイル 1 枚を解析してタイルプールへ登録する。
///
/// - `id`: アプリ側が採番したタイル ID(既存と重複する場合は置き換える)
/// - `feature_rgba`: 特徴量用サムネイル(32×32 固定。ホスト側でボックスフィルタ縮小済み)
/// - `compose_rgba`: 合成用サムネイル(長辺 64 上限、アスペクト維持。P4 合成用に保持)
/// - メモリガード超過時はエラーになり、プールは変更されない
/// - メイン画像設定済みの場合は差し替え評価の対象として記録し、
///   次の差分再マッチ([`begin_rematch`])で追随する(M6)
#[wasm_bindgen]
pub fn add_tile(
    id: u64,
    feature_rgba: Vec<u8>,
    compose_rgba: Vec<u8>,
    compose_w: u32,
    compose_h: u32,
) -> Result<JsTileInfo, JsValue> {
    let t0 = metrics::now_ms();
    TILE_POOL.with(|cell| {
        let mut pool = cell.borrow_mut();
        let info = pool
            .add_tile(id, &feature_rgba, &compose_rgba, compose_w, compose_h)
            .map(JsTileInfo::from_feature)
            .map_err(|err| js_error(&err.to_string()))?;
        MAIN_IMAGE.with(|cell| {
            if let Some(main) = cell.borrow_mut().as_mut() {
                // 現在の割当表の計算後に追加されたタイル(差し替え評価の対象。M6)
                main.tiles_added_since_match = true;
            }
        });
        // P2(タイル 1 枚)の解析スパン(M7)+ 生成トリガーの登録
        record_p2_tile_span(metrics::now_ms() - t0);
        mark_trigger("tile_added");
        Ok(info)
    })
}

/// プールからタイルを削除する。
///
/// 削除タイルが割当られていたブロックは未確定(None)に戻り、
/// 次の差分再マッチ([`begin_rematch`])で現プールから再割当てされる
/// (詳細設計書 4.4 差分再マッチ: タイル削除時)
#[wasm_bindgen]
pub fn remove_tile(id: u64) -> Result<(), JsValue> {
    TILE_POOL.with(|cell| {
        cell.borrow_mut()
            .remove_tile(id)
            .map_err(|err| js_error(&err.to_string()))
    })?;
    MAIN_IMAGE.with(|cell| {
        if let Some(main) = cell.borrow_mut().as_mut() {
            for slot in main.assigned.iter_mut() {
                if *slot == Some(id) {
                    *slot = None;
                }
            }
        }
    });
    mark_trigger("tile_removed");
    Ok(())
}

/// タイルプールを空にする(リセット操作に対応。合成用サムネイルを解放する)
#[wasm_bindgen]
pub fn clear_tiles() {
    TILE_POOL.with(|cell| {
        cell.borrow_mut().clear();
    });
}

/// 登録済みタイル数(進捗の分母・UI の枚数表示に使用)
#[wasm_bindgen]
pub fn get_tile_count() -> u32 {
    TILE_POOL.with(|cell| cell.borrow().tile_count())
}

/// 合成用サムネイルの合計バイト数(メモリガードの監視値。wasm32 では 4 GB 未満)
#[wasm_bindgen]
pub fn get_tiles_memory_bytes() -> u32 {
    TILE_POOL.with(|cell| {
        let total = cell.borrow().total_compose_bytes();
        u32::try_from(total).unwrap_or(u32::MAX)
    })
}
