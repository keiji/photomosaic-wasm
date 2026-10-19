# ハンドオフ資料 6: Android アプリ実装手順

| 項目 | 内容 |
|---|---|
| 性格 | Web アプリが一定整った段階(M4: 論理 API 凍結以降)での Android アプリ着手手順と、コア インターフェースへのフィードバックの流れ |
| 対象 | Android アプリ実装者、コア実装者 |
| 実行基盤 | **AndroidX JavaScript Engine(androidx.javascriptengine)のサンドボックス上で、Web と同一の WASM コアを実行する。ホストとの双方向通信は MessagePort API を第一選択とし、機能非対応時は named data + evaluate / Base64 evaluate へフォールバックする** |

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
- MessagePort が使えない場合は、機能フラグを確認して段階的にフォールバックする(§3.3)。MessagePort → named data + evaluate → Base64 文字列の evaluate、の順で選ぶ。MessagePort 経路では named data が無い場合も ArrayBuffer 入力で動作する。
- 画面破棄時は MessagePort を閉じて isolate を close し、リソースを解放する。サンドボックスプロセスの死亡に備えて再接続処理を持つ。

### 3.2 データフロー

```
Kotlin
  │ ①Photo Picker → Uri → デコード(EXIF 反映)→ 正規化縮小 → RGBA
  │ ②選択したトランスポートで RGBA をサンドボックスへ提供
  │    MessagePort / named data: バイト配列を直接提供
  │    Base64 evaluate: inputBegin + inputChunk でチャンク転送
  │ ③制御メッセージ(JSON)を送信: setMainImage / setBlockSize / addTile / run / rematch / cancel(§3.3 の一式)
  ▼
ホスト JS(サンドボックス内)
  │ ④コア: setMainImage / addTile / begin_run + step_run(バッチ処理 + 進捗)
  │ ⑤進捗・部分結果を MessagePort または evaluate outbox へ返す
  ▼
Kotlin(MessagePort 受信コールバック、または __pmDrain ポーリング → callbackFlow → StateFlow → Compose)
  │ ⑥完了: exportImage の RGBA を受領
  │ ⑦Bitmap 化 → PNG エンコード → MediaStore 保存
```

- 画像のデコード・縮小・PNG エンコードは Kotlin 側(プラットフォーム API)が担当する。サンドボックスには DOM/Canvas がないため、ホスト JS はピクセル配列の計算とメッセージングに専念する。
- 大容量データをメッセージ文字列に含めない。Kotlin → JS は MessagePort / named data 経路で RGBA などのバイト列を直接渡し、メッセージは参照(dataRef)のみを持つ。JS → Kotlin は MessagePort 経路でも ArrayBuffer を 512 KiB 単位のチャンクに分割する(AndroidX JavaScriptEngine の ArrayBuffer は Binder のサイズ上限を超えられないため)。Base64 evaluate 経路も同じ 512 KiB チャンクを使う。

### 3.3 メッセージプロトコル(概要)

control メッセージの種別は、詳細設計書 2 章で凍結した論理 API(M4+M5〜M8 追加分)の一式に対応させる:

| 種別 | 方向 | ペイロード(JSON) |
|---|---|---|
| control | Kotlin → JS | `{type: "setMainImage" \| "setBlockSize" \| "getBlockMeanColors" \| "addTile" \| "addTiles" \| "removeTile" \| "clearTiles" \| "clearMainImage" \| "getMetrics" \| "getConfig" \| "setConfig" \| "run" \| "rematch" \| "step" \| "cancel", id, dataRef?, meta?, config?, tiles?}` |
| inputBegin / inputChunk | Kotlin → JS | MessagePort のバイナリ入力、または Base64 evaluate 経路。`{type: "inputBegin", id: "main-1", length}` の後に、MessagePort では ArrayBuffer、Base64 evaluate では `{type: "inputChunk", id: "main-1", data: "<base64>"}` を送る。Base64 チャンクは 512 KiB 以下 |
| response | JS → Kotlin | `{type: "response", id, ok, grid?, tile?, tiles?, errors?, config?, metrics?, binary?, length?, error?}`(binary 応答は JSON の直後に 512 KiB 以下の ArrayBuffer チャンク、または Base64 チャンク) |
| progress | JS → Kotlin | `{type: "progress", phase_code, phase_ratio, overall_ratio, assigned_blocks, total_blocks}`(コアの ProgressEvent のフィールド名に一致。文言化は Kotlin 側リソースで行う) |
| batchDone | JS → Kotlin | `{type: "batchDone", row_begin, row_end, block_size, width, length}` の直後に該当範囲の合成済み RGBA(512 KiB 以下の ArrayBuffer チャンク、または Base64 チャンク) |
| result | JS → Kotlin | `{type: "result", width, height, length}` の直後に完成画像 RGBA(512 KiB 以下の ArrayBuffer チャンク、または Base64 チャンク) |
| stepDone | JS → Kotlin | `{type: "stepDone"}`(1 バッチ完了。Kotlin は `step` を返して次バッチを駆動する) |
| error / canceled | JS → Kotlin | `{type: "error", message}` / `{type: "canceled"}` |

- MessagePort 経路: Kotlin → JS は named data が使える場合 `provideNamedData` で渡し、メッセージには `dataRef` のみを含める。named data が無い場合は `inputBegin` の後に ArrayBuffer を MessagePort で送る。JS → Kotlin は JSON の直後に 512 KiB 以下の ArrayBuffer チャンクを複数送り、`length` に達した時点で完了とする。
- named data + evaluate 経路: 入力は `provideNamedData`、出力は `evaluateJavaScriptAsync("__pmDrain()")` のポーリングで受ける。JS は応答・進捗・バイナリを outbox に積み、バイナリは 512 KiB 単位の Base64 チャンクにする。
- Base64 evaluate 経路: named data も MessagePort も使わない場合。入力は `inputBegin` + `inputChunk`、出力は named data + evaluate 経路と同じ outbox / Base64 チャンクを使う。
- evaluate 経路の制御は `__pmHandleControl("<JSON>")`、受信は `__pmDrain()` を 16〜50ms 間隔でポーリングする。`stepDone` を受けたら `step` を送る。
- 正確な API 名・サイズ上限は androidx.javascriptengine の公式ドキュメントを正とし、A0/A2-2 で実機確認の上、本書と詳細設計書へ反映する。
- S2 の操作(ブロックサイズスライダー・タイル追加/削除の差分再マッチ・設定変更)を UI 仕様どおりに成立させるため、control 種別は凍結論理 API と同一の一式を用意する。進捗・部分結果の通知はバッチ駆動(`begin_run` / `step_run`)をホスト JS 内で担い、`step_run` の戻り値(progress / result)をメッセージへ変換する。サンドボックスに `setTimeout` が無いため、バッチ境界は `stepDone` → `step` の往復で作る。
- タイル一括登録(`addTiles`)は `{type: "addTiles", tiles: [{tileId, featureRef, composeRef, meta}]}` を 1 回送り、JS 側で `wasm_bindgen.add_tile` を順に呼ぶ。応答は `{tiles: [...], errors: ["tile 3: ..."]}` とし、成功分と失敗理由を分けて返す。Kotlin はデコード済みのタイルをまとめて渡し、部分成功時も成功分を UI に反映する。

## 4. プロジェクトセットアップ(A0)

1. Android Studio 最新版、Kotlin、Jetpack Compose(Compose コンパイラは Kotlin 版と組合せ固定)を準備。
2. 依存関係はバージョンカタログ(`gradle/libs.versions.toml`)で管理し、`build.gradle.kts` へのハードコード禁止(アーキテクチャガイドライン)。`androidx.javascriptengine` もカタログへ追加。
3. Web ビルド成果物の取り込み:
   - Gradle タスク(wasm-pack build → `assets/core/` へコピー)を定義し、Web と Android で成果物が常に一致するようにする。
   - グルーシップから画像 I/O(DOM 依存)を分離し、サンドボックス用スクリプトと .wasm のみを同梱する。
4. `INTERNET` パーミッションを **宣言しない**(完全オフラインの保証。レビュー項目にする)。
5. `minSdk` / `targetSdk` は Photo Picker と JavaScript Engine 対応状況の両面から決定(ActivityForResult 互換モードを併用)。

検収: `isSupported()` と `typeof WebAssembly` の確認 → コアの `getVersion()` を Compose 画面に表示。機内モードで動作する。

### 4.1 A0 実施結果(2026-10-19)

- 構成: Gradle 9.1.0 / AGP 9.0.1 / Kotlin 2.3.20 / Compose BOM 2026.03.01 / androidx.javascriptengine 1.1.1 / Detekt 1.23.8。`minSdk` は 26。
- Detekt 1.23.8 は JDK 25 では起動できないため、Gradle は JDK 21 で実行する(CI も Temurin 21)。`jvmToolchain(21)` を設定済み。
- 確認した API: `JavaScriptSandbox.isSupported()` は引数なし。`JS_FEATURE_WASM_COMPILATION` / `JS_FEATURE_PROMISE_RETURN` / `JS_FEATURE_PROVIDE_CONSUME_ARRAY_BUFFER` / `JS_FEATURE_CONSOLE_MESSAGING` / `JS_FEATURE_MESSAGE_PORTS` は実在。`JavaScriptConsoleCallback` で console 出力を logcat へ転送する。
- グルーは `wasm-pack --target no-modules` で生成し、`buildCoreGlue` → `SyncCoreAssets` で `assets/core/` へ取り込む。AGP 9 では SourceSet に Provider を渡せないため、Variant API の `addGeneratedSourceDirectory` を使う。
- 実行経路: Kotlin が `host/host.js` → グルー → `__pmInit(wasmSource, usePort, useNamedData)` の順に評価。named data 経路では `.wasm` を `provideNamedData` で渡し、ホスト JS が `android.consumeNamedDataAsArrayBuffer` → `WebAssembly.compile` → `wasm_bindgen.initSync({ module })` → `get_version()` を呼ぶ。Base64 evaluate 経路では `.wasm` を Base64 文字列として渡す。
- isolate には `TextDecoder` / `TextEncoder` が無いため、`host.js` で最小限の UTF-8 ポリフィルを定義してからグルーを評価する(初回実行で `TextDecoder is not defined` を確認し対処)。
- 検証結果: `:app:assembleDebug` / `:app:detekt` / `:app:testDebugUnitTest`(5 件)/ `:app:lintDebug` が成功。android-36 (google_apis_playstore, x86_64) エミュレータで「JavaScript エンジン: 対応」「WebAssembly: 利用可能」「コアバージョン: photomosaic-core 0.1.0」を表示。`aapt dump permissions` で `INTERNET` が無いことを確認。

## 5. 画像入出力(A1)

### 5.1 メディアピッカー

- メイン画像: `ActivityResultContracts.PickVisualMedia`(単一選択)
- 構成画像: `PickMultipleVisualMedia(maxItems)`(上限はストレージガイドに合わせ調整。超える場合は複数回の追加を案内)
- 権限不要(Photo Picker はメディアへの部分アクセスを OS が仲介する)

### 5.2 デコード(Kotlin 側)

- `ImageDecoder`(API 28 以降)または `BitmapFactory` で EXIF 回転を反映してデコードし、`ARGB_8888`(RGBA)へ正規化する(HEIC を含む、端末が対応する形式を扱う)。
- 長辺 4096px 超(解析用)は Kotlin 側で縮小して正規化(Web の `imageLoader.ts` と同じ仕様)。
- RGBA を named data でサンドボックスへ提供する。

### 5.3 保存・共有

- 保存: コアから RGBA を受領 → Bitmap 化 → `Bitmap.compress`(PNG)→ MediaStore の `Pictures/Photomosaic`(`RELATIVE_PATH`)へ書き込み。権限不要(スコープドストレージ)。
- 共有: FileProvider で一時公開 URI を作り `ACTION_SEND`(image/png)を発行。保存直後に共有シートを出すオプションを用意。

### 5.4 A1 実施結果(2026-10-19)

- 画像 I/O(`io/ImageLoader.kt`): API 28 以降は `ImageDecoder`(EXIF 回転を自動反映、`setTargetSize` で同時縮小)、API 26〜27 は `BitmapFactory` + `androidx.exifinterface` で回転を反映してから縮小する。アルファ付き画像は白背景へ合成して不透明化する。
- 正規化: メイン画像は長辺 4096px 以下(超過時は等比縮小)、タイルは合成用 64px 以下・特徴量用 32×32(面積平均のボックスフィルタ)を生成する。`normalizeSize` / `composeThumbSize` / `boxResize` は Android 非依存の純関数として単体テスト済み。
- S1 開始画面(`ui/editor/`): `PickVisualMedia` でメイン画像 1 枚、`PickMultipleVisualMedia` で構成画像を複数選択。プレビュー・正規化後サイズ・縮小案内・枚数・読み込み進捗・個別削除・20 枚までの初期表示(「すべて表示」で全件)を実装。エラー時は再選択を案内する。
- 保存・共有(`io/ImageExporter.kt`): API 29 以降は MediaStore の `Pictures/Photomosaic` へ PNG を保存(権限不要)。API 26〜28 は公開 Pictures へ保存するため `WRITE_EXTERNAL_STORAGE`(maxSdkVersion=28)を宣言し、実行時に権限が必要。共有はキャッシュ配下へ PNG を書き出し、FileProvider の content URI を `ACTION_SEND` へ渡す。保存・共有ボタンの UI 結線は、完成画像を生成する A2 で行う。
- 検証: ユニットテスト 13 件、実機テスト 12 件(デコード・EXIF・サムネイル・MediaStore 保存・FileProvider 共有・ViewModel・画面表示)が合格。`assembleDebug` / `detekt` / `lintDebug` も成功。エミュレータで 800×600 のメイン画像とタイル 2 枚を Photo Picker から選択し、プレビュー・「構成画像: 2 枚」・削除後の「1 枚」を確認した。

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

### 6.1 A2 実施結果

- プロトコル(`core/CoreModels.kt` / `core/JsCoreEngine.kt`): 制御は文字列 JSON、Kotlin → JS の RGBA は named data(`dataRef` のみを送る)、JS → Kotlin の部分結果・完成画像は JSON の直後に 512 KiB 以下の ArrayBuffer チャンクを送る方式で実装した。要求と応答は `id` で対応付け、60 秒でタイムアウトする。A2-2 で MessagePort 非対応時の evaluate フォールバックを追加した(§6.2)。
- バッチ駆動(`assets/host/host.js`): サンドボックスに `setTimeout` が無いため、`begin_run` / `begin_rematch` 後の 1 バッチごとに `stepDone` を送り、Kotlin が `step` を返すハンドシェイクでバッチ境界を作る。境界で `cancel`・設定変更を受け付ける。進捗は `progress`、部分結果は `batchDone` + バイナリ、完成は `result` + バイナリとして送る。
- 部分描画: `batchDone` の行範囲をグリッド全体の Bitmap へ `Canvas.drawBitmap` で転写し、`previewRevision` で Compose の再描画を促す。完成時は完成 RGBA を Bitmap 化して保存・共有に使う。
- S2 UI(`ui/editor/EditorScreen.kt` / `EditorViewModel.kt`): プレビュー(タップでメイン画像変更)、ブロックサイズ(8〜128px、300ms デバウンス)、メイン画像ブレンド(0〜0.8)、色補正(0〜1.0)、重複閾値(0.5〜8.0)、進捗バー(割当/全体・フェーズ・開閉)、キャンセル、構成画像の追加/削除(編集中は差分再マッチ)、保存/共有、戻る(全状態クリア)を実装した。保存は完成時のみ有効。API 26〜28 では保存前に `WRITE_EXTERNAL_STORAGE` を要求する。
- コア共有(`MainActivity.kt` / `StartupViewModel.kt`): 起動検査と編集画面で同一の `JsCoreEngine` を Activity スコープの `StartupViewModel` 経由で共有し、画面遷移でサンドボックスを作り直さない。
- 検証: `compileDebugKotlin` / `compileDebugAndroidTestKotlin` / `detekt` / `ktlint` / `lintDebug` / ユニットテスト 13 件が成功。実機テストは 15 件中 14 件成功・1 件スキップ(A2 時点)。スキップした `JsCoreEngineTest` は、検証用エミュレータの WebView 133/134 が `JS_FEATURE_MESSAGE_PORTS` を公開しないため `Assume` でスキップした。A2-2 でスキップを解除し、named data + evaluate フォールバック経路で生成できることを確認した(§6.2)。
- 既知の制約: MessagePort 非対応端末では evaluate フォールバックを使うため、MessagePort 経路より転送コストが大きい。Base64 evaluate 経路はさらに転送コストが大きい。

### 6.2 A2-2 実施結果(Graceful Degradation、2026-10-19)

- 機能判定: `JavaScriptSandbox.isFeatureSupported` で WASM / MessagePort / named data / Promise / `EVALUATE_WITHOUT_TRANSACTION_LIMIT` / isolate max heap を起動時に確認し、結果を logcat に記録する。
- トランスポート選択:
  1. `JS_FEATURE_MESSAGE_PORTS` が使える場合は MessagePort 経路。入力は named data が使えれば `provideNamedData`、無ければ `inputBegin` + ArrayBuffer、出力は 512 KiB 以下の ArrayBuffer チャンク。
  2. MessagePort が無い場合は named data + evaluate 経路。入力は `provideNamedData`、出力は `__pmDrain()` のポーリングで受ける。
  3. named data も無い場合は Base64 evaluate 経路。入力は `inputBegin` / `inputChunk`、出力は Base64 チャンクで受ける。
- MessagePort の機能フラグが true でも `createMessageChannel` が失敗する端末があるため、例外時は named data + evaluate へ落とす。
- evaluate 経路は `__pmHandleControl(json)` で制御を送り、JS の outbox を `__pmDrain()` で 16ms(処理中)/50ms(待機中)間隔でポーリングする。`batchDone` / `result` / binary response には `length` を付け、512 KiB 単位の Base64 チャンクが揃った時点で完了とする。
- 検証環境の WebView 機能値(android-36 エミュレータ、WebView 133): `wasm=true`, `messagePort=false`, `provideNamedData=true`, `promise=true`, `evaluateWithoutTransactionLimit=true`, `isolateMaxHeap=true`。このため実機テストは named data + evaluate 経路で実行した。
- 検証: `JsCoreEngineTest` のスキップを解除し、`start` → `setMainImage` → `getBlockMeanColors` → `addTile` → `run` → `Completed` が成功。Node.js 上では実 `.wasm` を使い、MessagePort + named data / MessagePort + ArrayBuffer 入力 / named data + evaluate / Base64 evaluate の 4 経路を検証した(`/tmp/opencode/host_real_core_test.js`, `host_messageport_binaryinput_test.js`, `host_fallback_test.js`, `host_string_fallback_test.js`)。`detekt` / `ktlint` も成功。
- 既知の制約: Base64 evaluate 経路は Binder のトランザクション上限を避けるため 512 KiB チャンクに分割する。`EVALUATE_WITHOUT_TRANSACTION_LIMIT` が無い端末でも、このチャンクサイズ(Base64 後 約 683 KiB)は 1 MiB 未満に収まる。非常に大きな画像では転送時間が増える。

## 7. 品質確認(A3)

| 項目 | 確認方法 |
|---|---|
| 完全オフライン | マニフェストに `INTERNET` が無いこと + 機内モードで全機能動作 |
| サンドボックス対応 | 非対応端末での案内表示。`isSupported()` / `typeof WebAssembly` の検査が機能すること |
| 結果の決定性 | 同一ホスト内で同一入力 → 同一出力(ハッシュ比較)。Web と Android の間は同一入力ピクセルに対するコア出力の決定性のみ検証し、入力のデコード差に起因する出力差は視覚一致で評価する |
| メタデータ不在 | GPS 付き EXIF の入力で生成した出力 PNG に EXIF が含まれないこと(`ExifInterface` で主要タグが空であることを確認) |
| 性能 | メトリクス JSON を実機で取得し、[性能計測設計](./05_performance_measurement.md) の目標と比較(JIT ウォームアップを考慮しベンチは 2 回実行) |
| 転送 | named data / MessagePort の転送時間を計測し、体感を損ねないことを確認 |
| メモリ | isolate のメモリ上限(端末依存)内で S-large が動作すること。超過時はエラーで安全に止まること |
| レイアウト | 縦持ち・横持ち・回転途中でも処理が破綻しない(ViewModel で状態保持) |
| プロセス死 | 生成中にバックグラウンド遷移→プロセス再起動してもクラッシュしない(状態は復元しなくてよい、エラー表示で救済) |

### 7.1 A3 実施結果(2026-10-19)

- 検証環境: android-36 エミュレータ(`medium_phone`)、WebView 133、トランスポートは `named_data_evaluate`。Android 実機の絶対目標値は設定せず、同一端末での前回比による変化検知を前提とする(handoff/05 §7)。
- 自動テスト: `QualityTest` 7 件、`MainActivityRecreateTest` 1 件、`EditorMemoryTest` 1 件を追加。全 instrumentation テスト 24 件が成功した。`detekt` / `ktlint` / `lintDebug` / `assembleDebug` / ユニットテストも成功。
- 完全オフライン: マニフェストに `INTERNET` と `ACCESS_NETWORK_STATE` が無いことをテストで確認。エミュレータを機内モードにして全 instrumentation テスト 24 件を実行し、成功した。
- サンドボックス非対応: 既存の `StartupScreenTest` で非対応案内文言を確認。`JavaScriptSandbox.isSupported()` と `typeof WebAssembly` の検査は起動時に実行される。
- 結果の決定性: 同一エンジン・同一入力で `run()` を 2 回実行し、完成 RGBA の SHA-256 が一致することを確認。部分結果の行範囲が先頭から連続していることも確認した。
- メタデータ不在: GPS・Make・Model を付与した JPEG をデコードして PNG 保存し、出力を `ExifInterface` で確認。GPS / Make / Model / DateTime / ImageDescription はいずれも空だった。
- 回転: `ActivityScenario.recreate()` で Activity を再生成し、クラッシュしないことを確認。状態は Activity スコープの ViewModel が保持する。
- プロセス死: アプリをバックグラウンドへ移動後、`adb shell am kill` でプロセスを終了し、再起動。クラッシュせず起動画面から再初期化されることを確認した(編集状態は復元しない)。
- 性能・転送(S-mid / S-large、コア内部メトリクスと Kotlin 側の実測):

| 条件 | P1 | P2 | P3 | P4 | コア合計 | `run` 実測 | メイン設定 | タイル追加 |
|---|---|---|---|---|---|---|---|---|
| S-mid: 4000×3000、300 枚 | 204 ms | 21 ms | 836 ms | 1,580 ms | 2,641 ms | 8,592 ms | 379 ms | 15,870 ms |
| S-large: 4000×3000、2,000 枚 | 198 ms | 73 ms | 7,367 ms | 1,549 ms | 9,187 ms | 15,111 ms | 325 ms | 105,342 ms |

  - S-mid の P4 はデスクトップ目標 1,000 ms を超えるが、Android は端末差が大きいため絶対目標を設けない。同一端末でのリグレッション監視に使う。
  - S-large は 2,000 枚でも isolate のメモリ上限内で完了した。タイルの合成サムネイルは 16×16 入力で `tiles_bytes=2,048,000`。
  - 転送は evaluate フォールバック経路のため、タイル 1 枚ごとに制御要求が発生する。300 枚で約 15.9 秒、2,000 枚で約 105 秒かかる。UI は読み込み進捗を表示するが、タイル一括登録 API は A4 のフィードバック候補とする。
- アプリ層メモリ: 12MP(4096×3072)のメイン画像と 50 枚のタイルで ViewModel 経由の生成が完了することを確認した。Bitmap の画素データはネイティブヒープに置かれるため、Java ヒープの OOM とは別に監視する。
- 判明した問題と修正: evaluate フォールバックで 12MP の完成 RGBA を受ける際、`ByteArrayOutputStream` の伸長と `toByteArray()` の複製で Java ヒープが OOM した。応答の `length` を先に受け取り、チャンク到着時に最終サイズの `ByteArray` を一度だけ確保する方式へ変更し、OOM を解消した。
- `getMetrics` を Kotlin の `CoreEngine` と host.js の control に追加し、実機テストからメトリクス JSON を取得できるようにした。
- A4-02 で Pixel 8a の MessagePort 経路を確認した。12MP の完成画像は 512 KiB の ArrayBuffer チャンクで受信する(§8.3)。

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

### 8.1 A4 課題台帳と仕分けルール(2026-10-19)

A4 は本書をフィードバックの正本として運用する。新しい課題はまず区分・優先度・次アクションを記録し、PR / Issue から本節を参照する。

| 区分 | 意味 | 処理 |
|---|---|---|
| CORE | Web でも同一コアビルド・同一入力で再現する | 詳細設計・論理 API を更新し、Web / Android 両方のテストを通す |
| HOST | Android のホスト実装・メッセージング層だけの問題 | Android 側で吸収し、既知の対処として本書へ記録する |
| SPEC | 仕様が未定義、または解釈が曖昧 | 論理 API・詳細設計を凍結して両ホストへ反映する |
| QA | 端末依存、または未検証の項目 | テストまたは実機マトリクスを追加して確認する |

| 優先度 | 基準 | 対応方針 |
|---|---|---|
| P1 | 主要経路の体感・信頼性に影響し、回避策が無い | 次スプリントで対応する |
| P2 | 回避策がある、または一部端末・条件のみで発生する | 計画に載せて対応する |
| P3 | ドキュメント・計測・将来の改善余地 | 台帳に残し、継続的に検討する |

判断フロー:
1. 同じコアビルド・同一入力で Web 再現を試す。
2. CORE なら詳細設計と論理 API を更新し、Web / Android の両テストを追加する。
3. HOST なら Android 側のみで吸収し、対処と再発防止テストを本書へ記録する。
4. SPEC なら仕様を凍結し、Web / Android の両ホストへ同じ解釈を反映する。
5. QA なら実機・API レベル・メモリ条件を追加して確認する。
6. 結果を台帳へ戻し、必要に応じて `03_detailed_design.md` / `05_performance_measurement.md` / 本書を更新する。

| ID | 課題 | 区分 | Web 再現 | 優先度 | 次アクション | 状態 |
|---|---|---|---|---|---|---|
| A4-01 | evaluate 経路のタイル登録が 1 枚ごとの制御要求で遅い(300 枚 約 15.9 秒、2,000 枚 約 105 秒) | HOST / CORE | 未確認(Web は直接呼び出しのため再現しない見込み) | P1 | `addTiles` control を実装し、転送時間を再計測する | Fixed(2026-10-19、§8.2) |
| A4-02 | MessagePort 経路の実機確認が必要(エミュレータの WebView 133 は非対応) | QA | - | P1 | Pixel 8a で生成・進捗・キャンセルを確認する | Fixed(2026-10-19、§8.3) |
| A4-03 | S-mid の P4 が 1.58 秒(エミュレータ)/ 2.98 秒(Pixel 8a)で、デスクトップ目標 1.0 秒を超える | CORE / 未判定 | 未確認 | P2 | Web の同一条件と比較し、コア改善の要否を判定する | Open |
| A4-04 | API 26〜28 の `WRITE_EXTERNAL_STORAGE` 保存経路が未検証 | QA | - | P2 | API 26 / 28 エミュレータで保存・共有を確認する | Open |
| A4-05 | 低メモリ実機での S-large(12MP・2,000 枚)が未検証 | QA | - | P2 | 2GB 級実機で生成完了と安全な失敗を確認する | Open |
| A4-06 | Display P3 などの広色域入力の正規化が未検証 | SPEC / QA | 未確認 | P2 | P3 画像を Web / Android で比較し、sRGB 変換ルールを仕様化する | Open |
| A4-07 | プロセス死後に編集状態を復元しない(起動画面から再初期化) | SPEC | - | P3 | 再初期化で許容するか、`SavedStateHandle` 等で復元するかを決定する | Open |
| A4-08 | evaluate ポーラーがアイドル時も 16 / 50ms 間隔で動作する | HOST | - | P3 | アイドル時の停止・間隔延長を検討し、消費電力を測る | Open |
| A4-09 | メトリクスは instrumentation テストからのみ取得できる | HOST | - | P3 | デバッグビルド限定の共有導線を検討する | Open |
| A4-10 | WebView の機能差により選択されるトランスポートが端末ごとに異なる | QA | - | P3 | 実機マトリクスで feature 値と選択経路を記録する | Open(Pixel 8a は `message_port` を確認済み) |

### 8.2 A4-01 実施結果(2026-10-19)

- `addTiles` control を追加し、タイル登録を 1 回の制御要求にまとめた。バイナリは従来どおりタイルごとの named data / 入力バッファで渡し、JS 側で `wasm_bindgen.add_tile` を順に呼ぶ。
- 応答は `{tiles: [...], errors: [...]}`。一部のタイルが失敗しても成功分を返し、Kotlin 側は成功分を UI に反映したうえでエラーを表示する。
- Kotlin API に `TileInput` / `TileBatchResult` / `CoreEngine.addTiles()` を追加。`EditorViewModel` はタイルをデコードしてから一括登録する。既存の `addTile()` は互換のため一括 API へ委譲する。
- `QualityTest` に一括登録と部分失敗のテストを追加。全 8 件が成功した。

| 条件 | 変更前(1 枚ずつ) | 変更後(一括) | 短縮率 |
|---|---:|---:|---:|
| タイル 300 枚(エミュレータ) | 15,870 ms | 181 ms | 約 88 倍 |
| タイル 2,000 枚(エミュレータ) | 105,342 ms | 717 ms | 約 147 倍 |
| タイル 300 枚(Pixel 8a) | - | 660 ms | - |
| タイル 2,000 枚(Pixel 8a) | - | 1,885 ms | - |

- エミュレータは android-36(`medium_phone`)、WebView 133、`named_data_evaluate`。Pixel 8a は Android 37、WebView 155、`message_port`。数値は Kotlin 側の `addTiles` 呼び出し全体の実測。
- バイナリ提供は依然としてタイルごとの参照単位であるため、Base64 evaluate 経路では入力側の evaluate 回数が残る。複数タイルを 1 つのバイナリブロブへ詰める最適化は、必要になった時点で別課題とする。

### 8.3 A4-02 実施結果(2026-10-19)

- Pixel 8a(Android 37、WebView 155、arm64-v8a)で機能値を確認: `wasm=true messagePort=true provideNamedData=true promise=true evaluateWithoutTransactionLimit=true isolateMaxHeap=true`。実際に `message_port` トランスポートが選択された。
- 初回の S-mid 実行で、48 MB の完成 RGBA を 1 つの ArrayBuffer として送った際に `IllegalArgumentException: arrayBuffer is too large: 48000000` が発生した。AndroidX JavaScriptEngine の ArrayBuffer は Binder のサイズ上限を超えられないため、MessagePort 経路の JS → Kotlin バイナリも 512 KiB 単位の ArrayBuffer チャンクへ分割するよう修正した。
- Kotlin 側は MessagePort / evaluate の双方で同じ受信バッファを使い、`length` に達した時点で完了とする。これにより 12MP の完成画像も MessagePort 経路で受信できる。
- Pixel 8a で全 instrumentation テスト 25 件が成功した。`QualityTest` は 8 件成功。S-mid / S-large の実測は以下。

| 条件(Pixel 8a) | P1 | P2 | P3 | P4 | コア合計 | `run` 実測 | メイン設定 | タイル追加 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| S-mid: 4000×3000、300 枚 | 391 ms | 89 ms | 1,535 ms | 2,979 ms | 4,994 ms | 5,690 ms | 716 ms | 660 ms |
| S-large: 4000×3000、2,000 枚 | 365 ms | 113 ms | 10,112 ms | 3,079 ms | 13,669 ms | 14,739 ms | 484 ms | 1,885 ms |

- Pixel 8a の P4 はエミュレータより遅い。端末差のため A4-03 の Web 比較とコア改善判定は継続する。
- エミュレータ WebView 133 では MessagePort 非対応のため、引き続き evaluate フォールバックが使われる。

## 9. タスク一覧(チェックリスト)

- [x] A0: セットアップ、javascriptengine 追加、isSupported / WASM 検査、`getVersion()` 表示
- [x] A1: Photo Picker・Kotlin デコード・保存・共有
- [x] A2: MessagePort 連携(進捗・部分描画・キャンセル)、UI を Web 仕様どおりに実装
- [x] A2-2: WebView 機能判定と Graceful Degradation(MessagePort → named data + evaluate → Base64 evaluate)
- [x] A3: 品質確認(オフライン・決定性・性能・転送・メモリ・回転・プロセス死)
- [x] A4: フィードバックの運用開始(§8.1 に仕分けルールと課題台帳を記載。A4-01 以降は継続)

## 10. Web 側へ返すべき合意事項(M4 凍結時に確認)

- 論理 API の関数シグネチャとバッファ形式(RGBA・行順・プレマルチプライでないこと)
- 進捗イベントの全フィールドと発火間隔
- キャンセルの意味論(バッチ境界・部分結果の保持)
- 設定 JSON のスキーマ(閾値パラメータ一式)
- メッセージプロトコル(control / progress / batchDone / result / error)と named data 参照(dataRef)、および evaluate フォールバック時の outbox / `length` / `inputBegin`・`inputChunk` の取り決め
- コアバージョンの表記と不一致時の UI 挙動
