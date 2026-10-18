//! コアの WASM バインディング(wasm-bindgen)。
//!
//! 薄い層の方針(詳細設計書 1.2): メモリ受け渡しとコールバック変換のみを担い、
//! アルゴリズムは [`photomosaic_core`](photomosaic_core) クレートに置く。
//! FFI(unsafe)はこのクレートには出さず、wasm-bindgen の安全な抽象のみを使う。

use photomosaic_core::progress::{Phase, PhasePlan, ProgressThrottle};
use wasm_bindgen::prelude::*;

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
