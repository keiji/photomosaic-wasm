# photomosaic-wasm

ユーザーが持ち込んだ 1 枚の画像(メイン画像)を小さなブロックに分割し、各ブロックにマッチする小画像(構成画像)を配置してフォトモザイクを生成するアプリケーション群。

- **共通コア**: Rust(WASM にコンパイル)。Web / Android で同一の .wasm を実行
- **Web アプリ**: TypeScript + Vite(本リポジトリの `web/`)
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
4. 生成ボタンでフォトモザイクを生成。進捗バー(割当済み/全体ブロック数)と
   フェーズ表示が進み、完成した行バッチから順にプレビューが置き換わる
   (WASM 経由・16ms 以上のスロットリング)。キャンセル操作あり
5. 保存で PNG ダウンロード、リセット/戻るで S1 へ戻る

メイン画像のグリッド計算はモック(M2 でコアへ移行)。WASM のロードに失敗した環境ではモックへフォールバックする。

### コア(WASM)のビルド

wasm-pack 生成物(`web/src/wasm/`)はリポジトリに同梱しており、**CI が最新コアソースから自動で再ビルドしてコミットする**。そのため、Web アプリの開発に Rust 環境は不要。

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

## ライセンス

MIT
