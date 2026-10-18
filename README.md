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

ブラウザで表示される URL を開く。初回アクセス後に以下が動作する(M0 時点。処理はモックコア):

1. S1(開始画面)でメイン画像をクリック/ドロップで設定
2. S2(編集画面)でグリッド線 + ブロック平均色のプレビューを表示
3. ブロックサイズスライダー(8〜128 px)でグリッドを再計算(300ms デバウンス)
4. 保存で PNG ダウンロード、リセット/戻るで S1 へ戻る

### 検査・テスト

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm run format      # Prettier 適用
npm test            # Vitest(単体テスト)
npm run build       # 型チェック + 本番ビルド(dist/ へ出力)
```

## ライセンス

MIT
