//! コアの WASM バインディング(wasm-bindgen)。
//!
//! 薄い層の方針(詳細設計書 1.2): メモリ受け渡しとコールバック変換のみを担い、
//! アルゴリズムは [`photomosaic_core`](photomosaic_core) クレートに置く。
//! FFI(unsafe)はこのクレートには出さず、wasm-bindgen の安全な抽象のみを使う。

use photomosaic_core::color::lab_to_srgb8;
use photomosaic_core::grid::{
    compute_block_features, compute_grid_info, BlockFeature, GridInfo, DEFAULT_BLOCK_SIZE,
};
use photomosaic_core::progress::{Phase, PhasePlan, ProgressThrottle};
use photomosaic_core::tile::{TileFeature, TilePool};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

/// コア内に保持するメイン画像の状態(詳細設計書 9 章のメモリ設計に基づき、
/// 解析・出力用の RGBA をコア内に保持する。exportImage で 1 回だけ取り出す)。
struct MainImageState {
    rgba: Vec<u8>,
    grid: GridInfo,
    features: Vec<BlockFeature>,
}

thread_local! {
    // WASM はシングルスレッドで動く(詳細設計書 8.1)ため thread_local + RefCell で十分
    static MAIN_IMAGE: RefCell<Option<MainImageState>> = const { RefCell::new(None) };

    /// タイルプール(P2 で解析したタイルの集合。P4 合成用サムネイルも保持)
    static TILE_POOL: RefCell<TilePool> = RefCell::new(TilePool::new());
}

/// JS 例外(Error インスタンス)を生成する。
/// 文字列を直接投げると JS 側のテスト・エラー処理で扱いにくいため、
/// エラーは必ず Error インスタンスとして伝播させる。
fn js_error(message: &str) -> JsValue {
    js_sys::Error::new(message).into()
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

    let grid = compute_grid_info(width, height, DEFAULT_BLOCK_SIZE);
    let features = compute_block_features(&rgba, width, height, DEFAULT_BLOCK_SIZE);

    MAIN_IMAGE.with(|cell| {
        *cell.borrow_mut() = Some(MainImageState {
            rgba,
            grid,
            features,
        });
    });

    Ok(JsGridInfo::from_grid(grid))
}

/// P1 再実行: ブロックサイズを変更してグリッド・ブロック特徴量を再計算する
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
        main.grid = compute_grid_info(width, height, px);
        main.features = compute_block_features(&main.rgba, width, height, px);
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
/// コア内バッファを 1 回だけ取り出す設計に対応し、M4 で合成結果の返却に差し替わる。
#[wasm_bindgen]
pub fn export_main_image() -> Result<Vec<u8>, JsValue> {
    MAIN_IMAGE.with(|cell| {
        let binding = cell.borrow();
        let Some(main) = binding.as_ref() else {
            return Err(js_error("main image is not set"));
        };
        Ok(main.rgba.clone())
    })
}

/// メイン画像の状態を破棄する(リセット操作に対応。大容量バッファを開放する)
#[wasm_bindgen]
pub fn clear_main_image() {
    MAIN_IMAGE.with(|cell| {
        *cell.borrow_mut() = None;
    });
}

/// 進捗デモ用のスロットル判定(ダミー処理を 16ms 間隔のバッチに区切って進める)。
///
/// JS 側のタイマーから現在時刻とダミー処理の進行率を渡すと、コア内の
/// [`ProgressThrottle`] が「16ms 以上の経過」または「1% 以上の変化」を判定し、
/// 発火すべきときだけ進捗イベントを返す(発火不要のときは `None`)。
///
/// 戻り値は `ResultBatch` の部分ではなく、UI 表示に必要なフィールドのみ。
#[wasm_bindgen]
pub struct ProgressDemo {
    throttle: ProgressThrottle,
    plan: PhasePlan,
    total_blocks: u32,
}

#[wasm_bindgen]
impl ProgressDemo {
    /// ダミー処理(M3 相当のマッチング)を想定した進捗デモを初期化する
    #[wasm_bindgen(constructor)]
    pub fn new(total_blocks: u32) -> ProgressDemo {
        ProgressDemo {
            throttle: ProgressThrottle::new(),
            plan: PhasePlan::full(),
            total_blocks,
        }
    }

    /// 現在時刻 `now_ms` と進行率 `ratio`(0.0..1.0)を渡し、
    /// 発火すべきときだけ [`JsProgressEvent`] を返す。
    #[wasm_bindgen]
    pub fn tick(&mut self, now_ms: f64, ratio: f32) -> Option<JsProgressEvent> {
        if !(0.0..=1.0).contains(&ratio) {
            return None;
        }
        if !self.throttle.should_emit(now_ms, ratio) {
            return None;
        }
        let assigned_blocks = (ratio * self.total_blocks as f32).round() as u32;
        Some(JsProgressEvent {
            phase_code: Phase::Match.code().to_string(),
            phase_ratio: ratio,
            overall_ratio: self.plan.overall_ratio(Phase::Match, ratio),
            assigned_blocks,
            total_blocks: self.total_blocks,
        })
    }
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
#[wasm_bindgen]
pub fn add_tile(
    id: u64,
    feature_rgba: Vec<u8>,
    compose_rgba: Vec<u8>,
    compose_w: u32,
    compose_h: u32,
) -> Result<JsTileInfo, JsValue> {
    TILE_POOL.with(|cell| {
        let mut pool = cell.borrow_mut();
        pool.add_tile(id, &feature_rgba, &compose_rgba, compose_w, compose_h)
            .map(JsTileInfo::from_feature)
            .map_err(|err| js_error(&err.to_string()))
    })
}

/// プールからタイルを削除する(M3 ではマッチ結果が存在しないため再マッチ対象なし)
#[wasm_bindgen]
pub fn remove_tile(id: u64) -> Result<(), JsValue> {
    TILE_POOL.with(|cell| {
        cell.borrow_mut()
            .remove_tile(id)
            .map_err(|err| js_error(&err.to_string()))
    })
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
