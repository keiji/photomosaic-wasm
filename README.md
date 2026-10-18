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
4. 進捗表示領域の「進捗デモ(WASM)」で、WASM コア経由の進捗コールバック(16ms 間隔・ダミー処理 1 秒)を確認
5. 保存で PNG ダウンロード、リセット/戻るで S1 へ戻る

メイン画像のグリッド計算はモック(M2 でコアへ移行)。WASM のロードに失敗した環境ではモックへフォールバックする。

### コア(WASM)のビルド

wasm-pack 生成物(`web/src/wasm/`)はリポジトリに同梱しているため、**clone 後に Rust 環境がなくても dev/build が動作する**。

コアを変更した場合は Rust ツールチェーン(rustup + `wasm32-unknown-unknown` ターゲット + wasm-pack)で生成物を更新する:

```bash
cd web
npm run wasm:build   # wasm-pack build core-wasm --release --target web → src/wasm/ へ出力
```

生成物の更新漏れは CI が検知する(ビルド結果との差分検証)。コア側の検査:

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
