//! フォトモザイク共通コア(Web / Android で同一の .wasm として実行)。
//!
//! レイヤー方針(詳細設計書 1.2):
//! - プラットフォーム非依存。画像デコード・エンコード・ファイル I/O を含まない
//! - 入出力は RGBA ピクセル配列(バイト順 R→G→B→A、行優先、非プリマルチプライ、sRGB)

pub mod color;
pub mod grid;
pub mod progress;
pub mod tile;

/// コアのバージョン文字列。UI がコアと UI の不整合を検知するために表示する
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
