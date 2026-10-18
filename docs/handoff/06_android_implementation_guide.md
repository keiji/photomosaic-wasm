# ハンドオフ資料 6: Android アプリ実装手順

| 項目 | 内容 |
|---|---|
| 性格 | Web アプリが一定整った段階(M4: 論理 API 凍結以降)での Android アプリ着手手順と、コア インターフェースへのフィードバックの流れ |
| 対象 | Android アプリ実装者、コア実装者 |
| 実行基盤 | **JavaScript エンジン(WebView が内蔵する V8)上で、Web と同一の WASM コアを実行する** |

## 1. 全体の進め方

```
[Web: M0〜M4]  論理 API と進捗仕様を凍結
      │
      ▼
[Android: A0〜A4]  Web と同じ論理 API を JavaScript エンジン(WebView)上で利用
      │                └─ 使いにくさが見つかったら ─┐
      ▼                                            │
[フィードバック] ◀──────────────────────────────────┘
   ・ブリッジ層の型・転送形式(Base64 など)の見直し
   ・進捗イベントの粒度・キャンセル挙動の調整
   ・変更は必ず core(共通ソース)に反映し、Web も追従して検証
```

- Android は UI を新規実装するが、**フォトモザイク処理は一切再実装しない**(Web と同一のホストバンドル + WASM を利用)。
- 発見した問題を Android 側だけで回避せず、可能な限りコア・ホストのインターフェース改善として昇格させる。これが本手順の最重要の原則である。

## 2. コアの実行方式(セキュリティ方針)

本プロジェクトの方針として、**JNI を通じてネイティブコードを実行する方式は採用しない**(自作ネイティブライブラリはセキュリティ表面となり得るため)。コアは Web と同一の WASM を、JavaScript エンジン上で実行する。

| 方式 | 概要 | 判定 |
|---|---|---|
| (a) オフスクリーン WebView(V8)を JavaScript エンジン ホストにし、Web と同一の JS グルーシップ + .wasm を実行 | ネイティブコードを一切含まない。V8 は WebView として OS が自動更新・サンドボックス化 | **採用** |
| (b) WASM ランタイム(wasm3 / wasmtime など)を JNI で埋め込む | .wasm をそのまま使える | 非採用: ネイティブライブラリと JNI グルーがセキュリティ表面として残る |
| (c) Rust コアを cdylib 化し JNI/UniFFI 経由で呼ぶ | 従来案 | **不採用**: JNI 経由のネイティブ実行はセキュリティ方針に反する |
| (d) 純 JVM(Kotlin)製の WASM インタプリタ(Chasm など) | ネイティブコード 0 | 見送り: 実験的で画像処理 workload の性能が不足する懸念。将来再評価 |

補足: QuickJS のような独立の JS エンジンを直接埋め込む案もネイティブライブラリ(JNI)が必要になるため非採用とする。WebView は「Android 端末に必ずあり、OS が保守する JavaScript エンジン」という点で最もリスクが低い。

## 3. WebView ホストの設計

### 3.1 ホストの構成

- 表示しないオフスクリーン WebView を生成し、`assets/host/` に同梱したホストページ(JS グルーシップ + .wasm)をロードする。ホストバンドルは Web 向けビルドの成果物をそのまま使う。
- ネットワーク遮断の多層防御:
  - `INTERNET` パーミッションを宣言しない(そもそも遠隔通信が不可能)。
  - `settings.blockNetworkLoads = true` を設定。
  - ホストページの読み込みはローカルアセット(`file:///android_asset/` または WebViewAssetLoader)のみ。
- ホストページ起動時に WebView の Chromium バージョンを検査し、最低バージョン未満なら案内を出す(コア未起動で画面を閉じさせないよう、フォールバック文言を用意)。

### 3.2 データフロー(ブリッジ設計)

```
Kotlin
  │ ①Uri → バイト列 → Base64
  │ ②evaluateJavascript("host.setMainImage(b64, meta)")   ※メインスレッド
  ▼
ホスト JS(WebView/V8)
  │ ③createImageBitmap(EXIF 反映)→ 正規化縮小
  │ ④コア: setMainImage / addTile / run(バッチ処理+進捗)
  │ ⑤進捗を随時通知
  ▼
@JavascriptInterface ブリッジ(WebView 側スレッド)
  │ ⑥onProgress(json) / onResult(pngBase64) / onError(json)
  ▼
Kotlin(メインスコープへ post → StateFlow → Compose 描画 / MediaStore 保存)
```

- 転送方針: **大容量のピクセルバッファをブリッジに通さない**。デコード・合成・PNG エンコードはホスト(WebView)内で完結させ、Kotlin との間は「入力ファイルのバイト列(Base64)」「完成 PNG(Base64)」「進捗 JSON」のみをやり取りする。
- `@JavascriptInterface` のコールバックは WebView 側スレッドで来るため、Kotlin 側でメインスレッドへ post してから扱う。
- ホストは ViewModel スコープで保持し、画面回転では破棄しない。破棄時は `cancel()` を呼んでから `destroy()` する。

## 4. プロジェクトセットアップ(A0)

1. Android Studio 最新版、Kotlin、Jetpack Compose(Compose コンパイラは Kotlin 版と組合せ固定)を準備。
2. 依存関係はバージョンカタログ(`gradle/libs.versions.toml`)で管理し、`build.gradle.kts` へのハードコード禁止(アーキテクチャガイドライン)。
3. Web ビルド成果物の取り込み:
   - Gradle タスク(wasm-pack build → `assets/host/` へコピー)を定義し、Web と Android で成果物が常に一致するようにする。
   - コミットに成果物を含めるか CI で生成するかは開発運用に合わせて決定(初回はコミット方式を推奨)。
4. `INTERNET` パーミッションを **宣言しない**(完全オフラインの保証。レビュー項目にする)。
5. `minSdk` / `targetSdk` は Photo Picker と WebView バージョン要件から決定(ActivityForResult 互換モードを併用)。

検収: 空の Compose 画面で、ホスト経由のコア `getVersion()` が表示される。機内モードでも動作する。

## 5. 画像入出力(A1)

### 5.1 メディアピッカー

- メイン画像: `ActivityResultContracts.PickVisualMedia`(単一選択)
- 構成画像: `PickMultipleVisualMedia(maxItems)`(上限はストレージガイドに合わせ調整。超える場合は複数回の追加を案内)
- 権限不要(Photo Picker はメディアへの部分アクセスを OS が仲介する)

### 5.2 デコード(ホスト内)

- Kotlin は Uri からバイト列を読み、Base64 化してホストへ渡すだけ。デコードはホスト JS の `createImageBitmap`(EXIF 反映: `imageOrientation: 'from-image'`)で行う。
- 長辺 4096px 超(解析用)はホスト内で縮小して正規化(Web の `imageLoader.ts` と同じ仕様)。

### 5.3 保存・共有

- 保存: ホスト内で完成画像を PNG エンコード → Base64 で受領 → Kotlin でデコード → MediaStore の `Pictures/Photomosaic`(`RELATIVE_PATH`)へ書き込み。権限不要(スコープドストレージ)。
- 共有: FileProvider で一時公開 URI を作り `ACTION_SEND`(image/png)を発行。保存直後に共有シートを出すオプションを用意。

## 6. コア連携と進捗(A2)

```kotlin
// イメージ: WebView ホスト + callbackFlow で進捗を StateFlow 化
val progress = webViewHost
    .runGenerate(config)          // callbackFlow<ProgressEvent>(内部は JS ブリッジ)
    .stateIn(viewModelScope, SharingStarted.Eagerly, ProgressEvent.idle())

progress.collectAsState().value.let { event ->
    ProgressBar(event.assignedBlocks, event.totalBlocks)
    PhaseLabel(event.phase)
}
```

- Kotlin は `evaluateJavascript` でホストへ指示し、長時間の処理は V8 内で進むため UI スレッドを塞がない。
- キャンセル: 画面離脱・再生成時に `cancel()` をホストへ送り、Kotlin 側のフローも閉じる。
- 部分結果(行バッチ完了の通知)を受けたら、ホスト側がその範囲のプレビュー PNG を返すので、Kotlin は `BitmapFactory` でデコードして Compose `Canvas` に転写する(行バッチ単位の転写負荷が高い場合は間引き描画)。
- UI 構造は Web と同じ(開始画面 → 編集画面: プレビュー / ブロックサイズスライダー / 横方向進捗バー / 保存)。基本設計書 2 章をそのまま Compose に写す。

検収: S-mid 相当データで Web と同等の時間で生成が完了し、進捗バー・段階的置き換えが動く。

## 7. 品質確認(A3)

| 項目 | 確認方法 |
|---|---|
| 完全オフライン | マニフェストに `INTERNET` が無いこと + `blockNetworkLoads` 設定 + 機内モードで全機能動作 |
| 結果の決定性 | 同一ホスト内で同一入力 → 同一出力(ハッシュ比較)。Web と Android の間は、コア出力が同一であること(ホスト側の縮小エンジン差は視覚一致で許容) |
| 性能 | メトリクス JSON を実機で取得し、[性能計測設計](./05_performance_measurement.md) の目標と比較(V8 ウォームアップを考慮しベンチは 2 回実行) |
| ブリッジ転送 | 入出力ファイル転送(Base64)の所要時間を計測し、体感を損ねないことを確認 |
| メモリ | V8 ヒープ上限(端末依存)内で S-large が動作すること。超過時はエラーで安全に止まること |
| レイアウト | 縦持ち・横持ち・回転途中でも処理が破綻しない(ViewModel で状態保持) |
| プロセス死 | 生成中にバックグラウンド遷移→プロセス再起動してもクラッシュしない(状態は復元しなくてよい、エラー表示で救済) |

## 8. コア インターフェースへのフィードバック(A4、以後継続)

Android 実装で典型的に浮上する課題と、その扱い:

| 課題の例 | 正しい処理 |
|---|---|
| ブリッジ転送(Base64)が端末で重い | 転送形式(チャンク分割・圧縮・TypedArray 直接転送の可否)を含めてホスト仕様を見直し、Web も追従 |
| 進捗イベントの粒度が UI 更新に対して粗い/細かい | 間隔仕様(16ms・1%)を見直し。コアのスロットリングを調整(共通仕様として更新) |
| EXIF・広色域(P3)画像の扱いがホスト内と想定で異なる | コアへの入力正規化ルール(色空間は sRGB に変換して渡す等)を詳細設計書に明記 |
| キャンセルのタイミングで部分結果の扱いが不明確 | 仕様(バッチ境界で有効・既存結果保持)を API ドキュメントへ追記 |
| WebView バージョンの古い端末で動かない | 最低バージョン要件を明文化し、ホストバンドルから除外している構文を確認 |

手順:
1. 問題を「Web でも再現するか」で仕分けする(再現 → コアの問題。非再現 → ブリッジ・ホスト層の問題)。
2. コア由来なら詳細設計書を更新した上で実装し、Web・Android 両方のテストを通す。
3. ホスト・ブリッジ由来なら Android 側のみで吸収し、対処を本書の「既知の対処」として記録する。

## 9. タスク一覧(チェックリスト)

- [ ] A0: セットアップ、ホストバンドル取り込み(Gradle タスク)、WebView バージョン検査、`getVersion()` 表示
- [ ] A1: Photo Picker・ホスト内デコード・保存・共有
- [ ] A2: コア連携(進捗・部分描画・キャンセル)、UI を Web 仕様どおりに実装
- [ ] A3: 品質確認(オフライン・決定性・性能・ブリッジ・メモリ・回転・プロセス死)
- [ ] A4: フィードバックの運用開始(課題の仕分けルールをチームで共有)

## 10. Web 側へ返すべき合意事項(M4 凍結時に確認)

- 論理 API の関数シグネチャとバッファ形式(RGBA・行順・プレマルチプライでないこと)
- 進捗イベントの全フィールドと発火間隔
- キャンセルの意味論(バッチ境界・部分結果の保持)
- 設定 JSON のスキーマ(閾値パラメータ一式)
- ホストバンドルと Web のバージョン整合(同一成果物を共有する取り決め)
- コアバージョンの表記と不一致時の UI 挙動
