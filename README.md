# photomosaic-wasm

ユーザーが持ち込んだ 1 枚の画像(メイン画像)を小さなブロックに分割し、各ブロックにマッチする小画像(構成画像)を配置してフォトモザイクを生成するアプリケーション群。

- **共通コア**: Rust(WASM にコンパイル)。Web / Android で同一の .wasm を実行
- **Web アプリ**: TypeScript + Vite(本リポジトリの `web/`)
- **純 TypeScript 版**: 同一 UI・アルゴリズムを WASM なしで実行する比較用ページ(`index_js.html`)
- **Android アプリ**: Kotlin + Jetpack Compose(M4 以降の着手。`androidx.javascriptengine` 上で同一の .wasm を実行)

設計ドキュメントは [docs/README.md](./docs/README.md) を参照。

## 完全オフライン

本アプリは完全オフラインで動作する。サーバーや外部サービスと一切通信しない(画像は端末の外に出ない)。

## Web アプリの開発

### 必要要件

- Node.js(動作確認: v24)

### セットアップ

```bash
cd web
npm install
```

### 開発サーバの起動

```bash
npm run dev
```

ブラウザで表示される URL を開く。初回アクセス後に以下が動作する:

1. S1(開始画面)でメイン画像をクリック/ドロップで設定
2. S2(編集画面)でグリッド線 + ブロック平均色のプレビューを表示
3. ブロックサイズスライダー(8〜128 px)でグリッドを再計算(300ms デバウンス)
4. 生成ボタンでフォトモザイクを生成。生成は Web Worker 内のコアで実行し、
   メインスレッドを止めずに不定進捗とフェーズを表示する。完成した行バッチから
   順にプレビューが置き換わる。キャンセル操作あり
5. 保存で選択形式(PNG / JPEG)でダウンロードし、リセット/戻るで S1 へ戻る。
   色補正の強さ・重複とみなす色の近さのスライダーで描画結果を調整できる
   (いずれもドラッグ確定時に再生成)

グリッド計算からフォトモザイク生成までは WASM コアを Web Worker で実行する。Worker の初期化に失敗した環境ではメインスレッド版の WASM コアへフォールバックし、それも失敗した場合はモックへフォールバックする。

### WASM 版 / 純 TypeScript 版

同じ UI を 2 つのコア実装で提供する。性能比較や WASM 非対応環境での動作確認に使う。

- WASM 版: `https://keiji.github.io/photomosaic-wasm/`(`index.html`)
- 純 TypeScript 版: `https://keiji.github.io/photomosaic-wasm/index_js.html`(`index_js.html`)

純 TypeScript 版は Rust コア(`core/src/*.rs`)を `web/src/core/js/` へ移植したもので、WASM をロードしない。両ページともコアを Web Worker で実行し、Service Worker により完全オフラインで動作する。

### コア(WASM)のビルド

wasm-pack 生成物(`web/src/wasm/`)はリポジトリに同梱しており、**CI が最新コアソースから自動で再ビルドしてコミットする**。そのため、Web アプリの開発に Rust 環境は不要。WASM は速度優先の `opt-level = 3` でビルドし、バイナリサイズは約 191 KB(CI の 500 KB 上限以内)に収めている。

コア(`core/`・`core-wasm/`)を変更した場合も、ローカルでの再ビルドは不要(プッシュ後の CI が生成物を更新する)。ローカルで試す場合は以下を実行する:

```bash
# 初回のみ: Rust ツールチェーンの導入
# ツールチェーンのバージョンは rust-toolchain.toml で固定(rustup が自動で選択)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# 生成物のローカル再ビルド
cd web
npm run wasm:build   # wasm-pack build core-wasm --release --target web → src/wasm/ へ出力
```

コア側の検査:

```bash
cd core
cargo fmt && cargo clippy -- -D warnings && cargo test
```

### 検査・テスト

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm run format      # Prettier 適用
npm test            # Vitest(単体テスト。WASM 生成物があれば結合テストも実行)
npm run build       # 型チェック + 本番ビルド(dist/ へ出力)
```

CI(.github/workflows/ci.yml)はプッシュ毎に cargo fmt/clippy/test + wasm-pack build + バイナリサイズチェック(≤ 500 KB)+ Web 側の全検査を実行する。

### GitHub Pages への公開

Web アプリは GitHub Pages のプロジェクトページとして公開する。

- URL: `https://keiji.github.io/photomosaic-wasm/`
- 実行トリガー: 手動実行(`workflow_dispatch`)または `v*` タグの push
- ワークフロー: `.github/workflows/pages.yml`
- リポジトリが private でも、公開された Pages サイトは public である

公開前に Vite の `base` を `/photomosaic-wasm/` に設定し、Service Worker の登録・キャッシュをプロジェクトページ配下で解決する。

## ライセンス

MIT
