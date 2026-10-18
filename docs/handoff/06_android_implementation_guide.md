# ハンドオフ資料 6: Android アプリ実装手順

| 項目 | 内容 |
|---|---|
| 性格 | Web アプリが一定整った段階(M4: 論理 API 凍結以降)での Android アプリ着手手順と、コア インターフェースへのフィードバックの流れ |
| 対象 | Android アプリ実装者、コア実装者 |
| 実行基盤 | **AndroidX JavaScript Engine(androidx.javascriptengine)のサンドボックス上で、Web と同一の WASM コアを実行する。ホストとの双方向通信は MessagePort API を使用する** |

## 1. 全体の進め方

```
[Web: M0〜M4]  論理 API と進捗仕様を凍結
      │
      ▼
[Android: A0〜A4]  Web と同じ論理 API を JavaScript エンジン(サンドボックス)上で利用
      │                └─ 使いにくさが見つかったら ─┐
      ▼                                            │
[フィードバック] ◀──────────────────────────────────┘
   ・MessagePort メッセージ形式・named data 受渡しの見直し
   ・進捗イベントの粒度・キャンセル挙動の調整
   ・変更は必ず core(共通ソース)に反映し、Web も追従して検証
```

- Android は UI を新規実装するが、**フォトモザイク処理は一切再実装しない**(Web と同一の .wasm を利用)。
- 発見した問題を Android 側だけで回避せず、可能な限りコア・ホストのインターフェース改善として昇格させる。これが本手順の最重要の原則である。

## 2. コアの実行方式(セキュリティ方針)

本プロジェクトの方針として、**JNI を通じてネイティブコードを実行する方式は採用しない**(自作ネイティブライブラリはセキュリティ表面となり得るため)。コアは Web と同一の WASM を、AndroidX の JavaScript Engine(androidx.javascriptengine)のサンドボックス上で実行する。

| 方式 | 概要 | 判定 |
|---|---|---|
| (a) AndroidX JavaScript Engine(`JavaScriptSandbox` / `JavaScriptIsolate`)上で実行し、MessagePort API で双方向通信 | アプリとは別プロセスのサンドボックス。ネイティブコードを一切含まない | **採用** |
| (b) WebView(V8)をホストにする | OS 提供の JS エンジン | 予備案: サンドボックス非対応端末のフォールバック候補。実装コストが増えるため初期スコープ外 |
| (c) WASM ランタイム(wasm3 / wasmtime など)を JNI で埋め込む | .wasm をそのまま使える | 非採用: ネイティブライブラリと JNI グルーがセキュリティ表面として残る |
| (d) Rust コアを cdylib 化し JNI/UniFFI 経由で呼ぶ | 従来案 | **不採用**: JNI 経由のネイティブ実行はセキュリティ方針に反する |
| (e) 純 JVM(Kotlin)製の WASM インタプリタ(Chasm など) | ネイティブコード 0 | 見送り: 実験的で画像処理 workload の性能が不足する懸念。将来再評価 |

端末対応の注意:
- `JavaScriptSandbox` は端末により対応状況が異なるため、起動時に `JavaScriptSandbox.isSupported()` を確認する。
- 初期方針は「対応端末のみ + 非対応端末への案内表示」とし、フォールバックが必要になった時点で (b) の評価を行う。
- サンドボックス内で WebAssembly が使用可能かを起動時に検査する(`typeof WebAssembly`)。V8 系の実装では利用可能なはずだが、端末実装に依存するため検収項目とする。

## 3. JavaScript エンジン ホストの設計

### 3.1 ホストの構成

- `JavaScriptSandbox` をアプリ(編集画面)起動時に接続し、以後使い回す。サンドボックスはアプリとは別プロセスで動くため、処理中も UI スレッドを塞がない。
- 1 セッションにつき 1 つの `JavaScriptIsolate` を使用する。isolate の初期化時に、`assets/core/` から読み込んだグルーシップ(DOM 非依存の orchestration スクリプト)と .wasm を評価してコアを起動する。
- 単発の制御は `evaluateJavaScriptAsync`、継続的な双方向通信は **MessagePort API**(`postMessage` / メッセージ受信コールバック)を使用する。
- 画面破棄時は MessagePort を閉じて isolate を close し、リソースを解放する。サンドボックスプロセスの死亡に備えて再接続処理を持つ。

### 3.2 データフロー

```
Kotlin
  │ ①Photo Picker → Uri → デコード(EXIF 反映)→ 正規化縮小 → RGBA
  │ ②named data 提供 API(バイト配列)で RGBA をサンドボックスへ提供
  │ ③MessagePort で制御メッセージ(JSON)を送信: setMainImage / addTile / run / cancel
  ▼
ホスト JS(サンドボックス内)
  │ ④コア: setMainImage / addTile / run(バッチ処理 + 進捗)
  │ ⑤進捗・部分結果を MessagePort へ postMessage(JSON)
  ▼
Kotlin(受信コールバック → callbackFlow → StateFlow → Compose)
  │ ⑥完了: exportImage の RGBA(named data)を受領
  │ ⑦Bitmap 化 → PNG エンコード → MediaStore 保存
```

- 画像のデコード・縮小・PNG エンコードは Kotlin 側(プラットフォーム API)が担当する。サンドボックスには DOM/Canvas がないため、ホスト JS はピクセル配列の計算とメッセージングに専念する。
- 大容量データをメッセージ文字列に含めない。RGBA などのバイト列は named data で渡し、メッセージは参照(dataRef)のみを持つ。

### 3.3 メッセージプロトコル(概要)

| 種別 | 方向 | ペイロード(JSON) |
|---|---|---|
| control | Kotlin → JS | `{type: "setMainImage" \| "addTile" \| "removeTile" \| "run" \| "cancel", dataRef: "...", meta: {...}}` |
| progress | JS → Kotlin | `{type: "progress", phase, phaseRatio, overallRatio, assignedBlocks, totalBlocks, message}` |
| batchDone | JS → Kotlin | `{type: "batchDone", rows: [begin, end], dataRef: "..."}`(該当範囲の合成済み RGBA) |
| result | JS → Kotlin | `{type: "result", dataRef: "..."}`(完成画像 RGBA) |
| error | JS → Kotlin | `{type: "error", code, message}` |

- 正確な API 名・サイズ上限は androidx.javascriptengine の公式ドキュメントを正とし、A0 で実機確認の上、本書と詳細設計書へ反映する。

## 4. プロジェクトセットアップ(A0)

1. Android Studio 最新版、Kotlin、Jetpack Compose(Compose コンパイラは Kotlin 版と組合せ固定)を準備。
2. 依存関係はバージョンカタログ(`gradle/libs.versions.toml`)で管理し、`build.gradle.kts` へのハードコード禁止(アーキテクチャガイドライン)。`androidx.javascriptengine` もカタログへ追加。
3. Web ビルド成果物の取り込み:
   - Gradle タスク(wasm-pack build → `assets/core/` へコピー)を定義し、Web と Android で成果物が常に一致するようにする。
   - グルーシップから画像 I/O(DOM 依存)を分離し、サンドボックス用スクリプトと .wasm のみを同梱する。
4. `INTERNET` パーミッションを **宣言しない**(完全オフラインの保証。レビュー項目にする)。
5. `minSdk` / `targetSdk` は Photo Picker と JavaScript Engine 対応状況の両面から決定(ActivityForResult 互換モードを併用)。

検収: `isSupported()` と `typeof WebAssembly` の確認 → コアの `getVersion()` を Compose 画面に表示。機内モードで動作する。

## 5. 画像入出力(A1)

### 5.1 メディアピッカー

- メイン画像: `ActivityResultContracts.PickVisualMedia`(単一選択)
- 構成画像: `PickMultipleVisualMedia(maxItems)`(上限はストレージガイドに合わせ調整。超える場合は複数回の追加を案内)
- 権限不要(Photo Picker はメディアへの部分アクセスを OS が仲介する)

### 5.2 デコード(Kotlin 側)

- `ImageDecoder`(API 28 以降)または `BitmapFactory` で EXIF 回転を反映してデコードし、`ARGB_8888`(RGBA)へ正規化する。
- 長辺 4096px 超(解析用)は Kotlin 側で縮小して正規化(Web の `imageLoader.ts` と同じ仕様)。
- RGBA を named data でサンドボックスへ提供する。

### 5.3 保存・共有

- 保存: コアから RGBA を受領 → Bitmap 化 → `Bitmap.compress`(PNG)→ MediaStore の `Pictures/Photomosaic`(`RELATIVE_PATH`)へ書き込み。権限不要(スコープドストレージ)。
- 共有: FileProvider で一時公開 URI を作り `ACTION_SEND`(image/png)を発行。保存直後に共有シートを出すオプションを用意。

## 6. コア連携と進捗(A2)

```kotlin
// イメージ: MessagePort 受信 → callbackFlow で進捗を StateFlow 化
val progress = jsEngineHost
    .runGenerate(config)   // callbackFlow<ProgressEvent>
    .stateIn(viewModelScope, SharingStarted.Eagerly, ProgressEvent.idle())

progress.collectAsState().value.let { event ->
    ProgressBar(event.assignedBlocks, event.totalBlocks)
    PhaseLabel(event.phase)
}
```

- MessagePort の受信コールバックは指定スレッドで来るため、メインスコープへ post してから扱う。
- キャンセル: 画面離脱・再生成時に MessagePort で `cancel` を送り、Kotlin 側のフローも閉じる。
- 部分描画: `batchDone` を受けたら該当行範囲の RGBA(named data)を Bitmap 化して Compose `Canvas` へ転写する(転写負荷が高い端末では間引き描画)。
- UI 構造は Web と同じ(開始画面 → 編集画面: プレビュー / ブロックサイズスライダー / 横方向進捗バー / 保存)。基本設計書 2 章をそのまま Compose に写す。

検収: S-mid 相当データで Web と同等の時間で生成が完了し、進捗バー・段階的置き換えが動く。

## 7. 品質確認(A3)

| 項目 | 確認方法 |
|---|---|
| 完全オフライン | マニフェストに `INTERNET` が無いこと + 機内モードで全機能動作 |
| サンドボックス対応 | 非対応端末での案内表示。`isSupported()` / `typeof WebAssembly` の検査が機能すること |
| 結果の決定性 | 同一ホスト内で同一入力 → 同一出力(ハッシュ比較)。Web と Android の間は、コア出力が同一であること(Kotlin 側縮小エンジンの差は視覚一致で許容) |
| 性能 | メトリクス JSON を実機で取得し、[性能計測設計](./05_performance_measurement.md) の目標と比較(JIT ウォームアップを考慮しベンチは 2 回実行) |
| 転送 | named data / MessagePort の転送時間を計測し、体感を損ねないことを確認 |
| メモリ | isolate のメモリ上限(端末依存)内で S-large が動作すること。超過時はエラーで安全に止まること |
| レイアウト | 縦持ち・横持ち・回転途中でも処理が破綻しない(ViewModel で状態保持) |
| プロセス死 | 生成中にバックグラウンド遷移→プロセス再起動してもクラッシュしない(状態は復元しなくてよい、エラー表示で救済) |

## 8. コア インターフェースへのフィードバック(A4、以後継続)

Android 実装で典型的に浮上する課題と、その扱い:

| 課題の例 | 正しい処理 |
|---|---|
| named data 転送が端末で重い | 転送形式(チャンク分割・圧縮・直接参照の可否)をホスト仕様として見直し、Web も追従 |
| MessagePort メッセージの粒度が UI 更新に対して粗い/細かい | 進捗間隔仕様(16ms・1%)を見直し。コアのスロットリングを調整(共通仕様として更新) |
| EXIF・広色域(P3)画像の扱いが Kotlin デコードと想定で異なる | コアへの入力正規化ルール(色空間は sRGB に変換して渡す等)を詳細設計書に明記 |
| キャンセルのタイミングで部分結果の扱いが不明確 | 仕様(バッチ境界で有効・既存結果保持)を API ドキュメントへ追記 |
| サンドボックス非対応端末が想定より多い | フォールバック戦略の再決定(対応端末限定 + 案内、または WebView 予備案の評価) |

手順:
1. 問題を「Web でも再現するか」で仕分けする(再現 → コアの問題。非再現 → ホスト・メッセージング層の問題)。
2. コア由来なら詳細設計書を更新した上で実装し、Web・Android 両方のテストを通す。
3. ホスト・メッセージング由来なら Android 側のみで吸収し、対処を本書の「既知の対処」として記録する。

## 9. タスク一覧(チェックリスト)

- [ ] A0: セットアップ、javascriptengine 追加、isSupported / WASM 検査、`getVersion()` 表示
- [ ] A1: Photo Picker・Kotlin デコード・保存・共有
- [ ] A2: MessagePort 連携(進捗・部分描画・キャンセル)、UI を Web 仕様どおりに実装
- [ ] A3: 品質確認(オフライン・決定性・性能・転送・メモリ・回転・プロセス死)
- [ ] A4: フィードバックの運用開始(課題の仕分けルールをチームで共有)

## 10. Web 側へ返すべき合意事項(M4 凍結時に確認)

- 論理 API の関数シグネチャとバッファ形式(RGBA・行順・プレマルチプライでないこと)
- 進捗イベントの全フィールドと発火間隔
- キャンセルの意味論(バッチ境界・部分結果の保持)
- 設定 JSON のスキーマ(閾値パラメータ一式)
- メッセージプロトコル(control / progress / batchDone / result / error)と named data 参照(dataRef)の取り決め
- コアバージョンの表記と不一致時の UI 挙動
