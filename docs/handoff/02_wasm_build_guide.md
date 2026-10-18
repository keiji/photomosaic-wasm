# ハンドオフ資料 2: WASM バイナリの開発手順

| 項目 | 内容 |
|---|---|
| 性格 | Go / Rust から実行可能な .wasm を作成するまでの手順と、本プロジェクトでの利用形態 |
| 対象 | 共通コアを実装する開発者 |

本プロジェクトの言語選定(Rust 推奨)の結論は [03_go_vs_rust.md](./03_go_vs_rust.md) を参照。本書では両言語の手順を併記する。

## 1. 全体像

```
[Rust または Go のソース]
        │ クロスコンパイル
        ▼
[.wasm バイナリ + グルーコード]
        │
        ├─ Web: ページの JS から import して呼び出し (wasm-bindgen 生成グルーシップ / wasm_exec.js)
        └─ Android: JavaScript エンジン(WebView 内蔵の V8)をホストに、Web と同一のグルーシップ + .wasm を実行
```

重要な前提: Android も Web と同じ .wasm を実行する。Android SDK には WASM ランタイムが標準搭載されていないため、JavaScript エンジン(WebView が内蔵する V8)を処理ホストとして使用する。JNI 経由でネイティブコードを動かす方式(自作 cdylib 等)はセキュリティリスクの観点から採用しない。したがって「.wasm を作る」作業は Web と Android の両方を兼ねる。

## 2. Rust で作る場合(推奨)

### 2.1 ツールチェーンの準備

```bash
# Rust 本体(rustup)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# wasm-pack(バインディング生成・パッケージ化の標準ツール)
cargo install wasm-pack

# wasm-opt バイナリサイズ縮小(binaryen)
# ディストリのパッケージ(binaryen)または npm i -D wasm-opt
```

### 2.2 プロジェクト構成(Cargo.toml)

```toml
[package]
name = "photomosaic-core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"

[profile.release]
opt-level = "z"        # サイズ重み(速度優先なら "s" または 3)
lto = true
codegen-units = 1
panic = "abort"        # unwind コードを削る
strip = true
```

### 2.3 ビルドと成果物

```bash
# Web 向け(ESM グルーシップ生成)
wasm-pack build core --release --target web --out-dir ../web/src/wasm

# 成果物
#   photomosaic_core_bg.wasm   … 本体バイナリ
#   photomosaic_core.js        … import 用グルーシップ
#   photomosaic_core.d.ts      … 型定義(自動生成)
```

生成された `d.ts` をそのまま TypeScript から import する。Vite では特別な設定なしで動く
(`vite-plugin-wasm` が必要になるケース: top-level await を使う初期化の場合)。

### 2.4 バインディングの書き方(wasm-bindgen)

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn set_main_image(rgba: Vec<u8>, width: u32, height: u32) -> JsValue {
    // Vec<u8> は JS 側では Uint8Array として渡せる
    // 戻り値は serde-wasm-bindgen で JSON 化するか、専用 struct を輸出する
    todo!()
}

#[wasm_bindgen]
pub fn set_progress_callback(cb: js_sys::Function) {
    // 進捗コールバックは js_sys::Function で受け、バッチ境界で呼ぶ
    todo!()
}
```

バッファ受け渡しの指針:
- 画像 1 枚(数 MB〜数十 MB)の受け渡しは `Vec<u8>` / `Uint8Array` 経由で問題ない(コピー 1 回)。
- 極端に大きなバッファを頻繁に往復させないため、コア内に出力バッファを保持し `exportImage()` で 1 回だけ取り出す設計とする(詳細設計書 2 章の API に対応)。

### 2.5 サイズ最適化

| 手段 | 効果 |
|---|---|
| `opt-level = "z"` + `lto` + `panic = "abort"` | 最重要。総合で 2〜3 割減 |
| `wasm-opt -Oz` (binaryen) | 追加で 1〜2 割減 |
| `console_error_panic_hook` を release で外す | デバッグ用フックの削減 |
| 不要な crate を依存に入れない(デコーダを含まない) | コアは I/O 無しの方針なので自然に小さい |

目安: 本コアのような純粋計算であれば、最適化後に 100〜400 KB 程度に収まる。

### 2.6 テスト

```bash
# ネイティブでのユニットテスト(高速)
cargo test

# WASM 実機相当でのテスト(ブラウザ or node)
wasm-pack test --headless --firefox   # または --node
```

- アルゴリズム本体はプラットフォーム非依存のため、通常の `cargo test` で担保する。
- WASM 側テストは「バインディング経由で同じ結果になること」「メモリ操作が壊れないこと」の確認に限定する。

### 2.7 Android での実行(JavaScript エンジン ホスト)

- Android では別のネイティブビルド(cargo-ndk による cdylib など)を行わない。Web 向けビルドの成果物(グルーシップ + .wasm)を `android/app/src/main/assets/host/` に同梱し、オフスクリーン WebView(V8)上で実行する。
- Gradle タスクで Web のビルド成果物を assets へコピーし、Web と Android でバージョンがずれないようにする。
- 互換性の注意: WebView の Chromium バージョンに依存する構文(top-level await など)は、対象の最低 WebView バージョンを確認した上で使用する。ランタイムで WebView バージョンを検査し、旧端末には対応メッセージを表示する。
- 詳細な手順は [06_android_implementation_guide.md](./06_android_implementation_guide.md) を参照。

## 3. Go で作る場合

### 3.1 標準ツールチェーン(GOOS=js)

```bash
# ビルド
GOARCH=wasm GOOS=js go build -o web/app.wasm ./cmd/core

# グルーコード(wasm_exec.js)を配布物へコピー
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" web/
```

```html
<script src="wasm_exec.js"></script>
<script>
  const go = new Go();
  const { instance } = await WebAssembly.instantiateStreaming(
    fetch("app.wasm"), go.importObject);
  go.run(instance);
</script>
```

特性:
- ランタイム(GC・スケジューラ)込みで最小でも 1.5〜2.5 MB 程度のバイナリになる。
- GC の都合でメモリ使用量が読みにくく、大きな画像バッファを長期保持すると圧迫しやすい。
- 関数の輸出は `//export` ではなく、Go 側で `js.Global()` を使って JS へ関数を公開する形になる(型付きバインディング生成なし)。

### 3.2 GOOS=wasip1(Go 1.21 以降)

```bash
GOOS=wasip1 GOARCH=wasm go build -o core.wasm ./cmd/core
```

- WASI 向けのターゲット。ブラウザでは WASI シムが必要で、`GOOS=js` よりブラウザ用途のメインストリームではない。

### 3.3 TinyGo(サイズを減らす選択肢)

```bash
tinygo build -o web/app.wasm -target wasm ./cmd/core
```

- 数百 KB 台まで縮むが、`reflect`・一部標準ライブラリの制限があり、image 系パッケージの互換性は要検証。

### 3.4 Android での実行(参考)

- Go でも WebView ホスト上で `wasm_exec.js` 経由で実行できる。ただし Go ランタイム込みのバイナリ(1.5 MB 超)をモバイル端末で動かすことになり、サイズ・メモリの点で不利である([03_go_vs_rust.md](./03_go_vs_rust.md) 参照)。

## 4. 共通の運用上の注意

| 項目 | 注意点 |
|---|---|
| MIME タイプ | サーバは `.wasm` を `application/wasm` で配信する(`instantiateStreaming` の前提) |
| オフライン | WASM バイナリ自体を Service Worker のキャッシュ対象に含める |
| バージョン管理 | コアのバージョン(`getVersion()`)を UI に表示し、WASM と UI の不整合を検知できるようにする |
| 決定性 | 浮動小数演算の結果を Web/Android で一致させるため、計算順序をコア内で固定する(f32 と f64 を混ぜない等) |
| CI | Rust: `cargo fmt` / `cargo clippy` / `cargo test` / `wasm-pack build` を必須チェックにする |
| サイズ監視 | CI でバイナリサイズの上限チェック(例: 1 MB 超えたら失敗)を行い、肥大化を早期に検知する |

## 5. 検収基準(本手順の完了定義)

- [ ] `wasm-pack build`(または Go ビルド)が CI で再現的に成功する
- [ ] 生成バイナリが目標サイズ以内である(既定 500 KB 以下、例外は文書化)
- [ ] サンプル関数 1 個を Web の JS と Android の JavaScript エンジン ホスト(Kotlin 経由)の両方から呼び出し、値が往復することをテストで確認済み
- [ ] MIME タイプ・オフラインキャッシュの扱いが Web アプリ側に反映されている
