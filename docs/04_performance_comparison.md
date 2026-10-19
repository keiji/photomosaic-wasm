# JS / WASM 速度比較

## 1. 目的

WASM 版(`index.html`)と純 TypeScript 版(`index_js.html`)の速度差を記録する。

初期計測では、サイズ優先でビルドした WASM より純 TypeScript 実装の方が速かった。
その後、WASM を速度優先ビルドへ変更して再計測した経過を残す。あわせて、行バッチごとの
`requestAnimationFrame` を省略した場合の差と、Web Worker 実装・ブラウザ実測を記録する。

## 2. 結論

- 初期の WASM は `opt-level = "z"` のサイズ優先ビルドで、純 TypeScript 実装より遅かった。
- `opt-level = 3` に変更すると WASM の P3/P4 は約 28〜31% 改善し、計算のみでは
  純 TypeScript 実装より速くなった。
- メインスレッド版では、行バッチごとの `requestAnimationFrame` 待ちが差を小さくする。
- `requestAnimationFrame` を省略すると計算差は見えやすいが、そのままでは UI が固まる。
- WASM/JS の両コアを Web Worker で実行する構成を実装し、rAF 待ちを廃止した。
  UI は Indeterminate progress を表示し、生成中も操作を継続できる。
- ブラウザ上の Worker 実測(1920x1080、タイル 300 枚)では、JS Worker が約 336 ms、
  現行の `opt-level = 3` WASM Worker が約 237 ms、最適化前の `opt-level = "z"` WASM Worker
  が約 345 ms だった。
- 現行の `opt-level = 3` WASM は JS Worker より約 29% 速い。最適化前のサイズ優先 WASM は
  JS Worker より約 3% 遅かった。
- `core-wasm/Cargo.toml` と `web/src/wasm/` は `opt-level = 3` に更新済み。
  バイナリサイズは 191,728 bytes で、500 KB 上限以内に収まっている。
- WASM の真のマルチスレッド化は、`SharedArrayBuffer` と COOP/COEP が必要で、
  P3 の逐次依存も残るため、まず Web Worker による非ブロック化を優先する。

## 3. 計測環境

### 3.1 Node 上のコア単体

- CPU: AMD Ryzen 7 PRO 6850U(8 コア / 16 スレッド)
- OS: Linux x86_64
- Node.js: v24.21.0
- 計測対象: コア単体(Node 上)。ブラウザの画面操作を含む実測ではない。
- メイン画像: 1920x1080 RGBA
- タイル: 300 枚。特徴量サムネイル 32x32、合成サムネイル 64x64
- ブロックサイズ: 24 px
- 設定: 既定値。`row_batch` のみ 8 または 32 に変更
- 計測回数: 3 回の中央値。初回は JIT ウォームアップを含むため、中央値で比較
- 純 TypeScript 版の計算のみの計測では、`requestAnimationFrame` を同期実行に置換
- 純 TypeScript 版の UI 相当の計測では、`setTimeout(16)` によるバッチ待ちを再現
- 出力 RGBA は全条件で WASM と完全一致(不一致 0 バイト)

### 3.2 ブラウザ上の Worker

- ブラウザ: Chrome 155.0.8059.84(ヘッドレス)
- OS / CPU: Linux x86_64 / AMD Ryzen 7 PRO 6850U
- 配信: Vite の本番ビルドを `vite preview` で配信
- メイン画像: 1920x1080 RGBA
- タイル: 300 枚。合成サムネイル 64x64
- ブロックサイズ: 24 px、設定は既定値(`row_batch = 8`)
- 計測区間: 生成ボタンのクリックから保存ボタンが有効になるまで。
  Worker RPC、P1〜P4、完成画像の受信、Canvas 描画を含む。
  画像デコードとタイル読み込みは含まない。
- 計測回数: 1 回のウォームアップ後に 5 回計測し、中央値で比較
- 現行の `opt-level = 3` と、最適化前の `opt-level = "z"` を同じ Worker 構成で計測
- 出力 Canvas のサンプルチェックサムは JS Worker と WASM Worker で一致

## 4. 初期計測: サイズ優先 WASM と JS

最適化前の WASM は `core-wasm/Cargo.toml` で `opt-level = "z"`、`lto = true`、
`wasm-opt = false` としていた。500 KB 以内のバイナリサイズ目標を優先した設定である。
現在は第 5 節の計測結果を踏まえ、`opt-level = 3` を採用している。

1920x1080、タイル 300 枚、`row_batch = 8` の中央値:

| 実装                              |       run | 合計(set main + add tiles + run) |
| --------------------------------- | --------: | -------------------------------: |
| WASM(`opt-level = "z"`、最適化前) | 約 334 ms |                        約 382 ms |
| 純 TypeScript                     | 約 270 ms |                        約 332 ms |

この条件では、純 TypeScript 実装の方が速い。

`row_batch = 32` の中央値:

| 実装                              |       run |      合計 |
| --------------------------------- | --------: | --------: |
| WASM(`opt-level = "z"`、最適化前) | 約 381 ms | 約 428 ms |
| 純 TypeScript                     | 約 276 ms | 約 340 ms |

初期計測の時点では、WASM の計算速度より、JS↔WASM の境界コピーと
サイズ優先ビルドの影響が大きかった。

## 5. WASM の速度最適化

初期の `opt-level = "z"` に対して、まず環境変数で `opt-level = 3` に上書きした
比較用 WASM を `/tmp` にビルドして計測した。

```bash
PATH="$HOME/.cargo/bin:$PATH" \
CARGO_PROFILE_RELEASE_OPT_LEVEL=3 \
wasm-pack build ../core-wasm --release --target web \
  --out-dir /tmp/photomosaic-wasm-opt3
```

計測結果を踏まえ、現在は `core-wasm/Cargo.toml` の `[profile.release]` を
`opt-level = 3` に変更し、`npm run wasm:build` で `web/src/wasm/` を再ビルド済み。
CI と GitHub Pages も同じ `npm run wasm:build` を使うため、CI が生成する WASM も
`opt-level = 3` になる。

バイナリサイズ:

| ビルド                      |        サイズ |
| --------------------------- | ------------: |
| `opt-level = "z"`(最適化前) | 176,271 bytes |
| `opt-level = 3`(現行)       | 191,728 bytes |

サイズは約 9% 増加したが、191,728 bytes で 500 KB 上限以内に収まっている。
CI のサイズチェック(512,000 bytes 以下)も満たす。

1920x1080、タイル 300 枚、`row_batch = 8` の中央値:

| 実装                  |       run |      合計 |
| --------------------- | --------: | --------: |
| WASM(`opt-level = 3`) | 約 230 ms | 約 274 ms |
| 純 TypeScript         | 約 270 ms | 約 332 ms |

`opt-level = 3` により WASM の run は約 31% 改善し、合計では純 TypeScript 実装より
約 17% 速くなった。

`row_batch = 32` の中央値:

| 実装                  |       run |      合計 |
| --------------------- | --------: | --------: |
| WASM(`opt-level = 3`) | 約 275 ms | 約 317 ms |
| 純 TypeScript         | 約 268 ms | 約 330 ms |

`row_batch = 32` では run 単体は純 TypeScript の方がわずかに速いが、
P1/P2 を含む合計では WASM が約 4% 速い。

## 6. `requestAnimationFrame` を省略した場合

メインスレッド版のコアは、行バッチごとに `requestAnimationFrame` で UI に制御を返す。
この待ち時間は 1 バッチあたり約 16 ms で、計算差を覆い隠す。

1920x1080 は 45 ブロック行。`row_batch = 8` では P3/P4 合計で 12 バッチ、
待ち時間は約 176 ms になる。`row_batch = 32` では 4 バッチ、待ち時間は約 48 ms になる。

`opt-level = 3` の計算時間にバッチ待ちを加えたページ相当の概算:

| `row_batch` |      WASM | 純 TypeScript |     差 |
| ----------- | --------: | ------------: | -----: |
| 8           | 約 450 ms |     約 508 ms | 約 11% |
| 32          | 約 365 ms |     約 378 ms |  約 3% |

`requestAnimationFrame` を省略すると計算差は見えやすくなるが、
そのままではメインスレッドが長時間占有され、画面操作・描画が止まる。

## 7. Web Worker 実装とブラウザ実測

### 7.1 実装概要

WASM 版と JS 版の両方で、コアを Web Worker 内で実行する。

構成:

- `web/src/core/workerProtocol.ts`: RPC メッセージ型。
- `web/src/core/workerRuntime.ts`: Worker 側ランタイム。初期化、RPC、進捗・部分結果送信。
- `web/src/core/wasm.worker.ts` / `js.worker.ts`: 各コアの Worker エントリ。
- `web/src/core/workerBridge.ts`: メインスレッド側 `WorkerCoreBridge`。`CoreBridge` 互換 API。

処理:

- Worker 初期化時にコアを生成し、`onProgress` / `onResult` を Worker から postMessage する。
- `createWasmCore` / `createJsCore` は `scheduleNextBatch` オプションを受け取る。
  Worker では `setTimeout(callback, 0)` を注入し、メインスレッドの rAF を使わない。
- バッチ境界で Worker のイベントループへ制御を返すため、キャンセル要求と
  進捗メッセージを処理できる。
- メイン画像、タイル特徴量、タイル合成画像、部分結果、完成画像は transferable で送受信する。
- `getBlockMeanColors` / `getTileCount` / `getTilesMemoryBytes` は同期 API のため、
  メインスレッド側で Worker 応答時の値をキャッシュする。
- Worker 初期化に失敗した場合はメインスレッド版コアへフォールバックする。
  WASM 版は WASM → モック、JS 版は JS の順。
- Vite の Worker は `worker.format = 'es'` で出力する。Worker 内で WASM ローダーを
  動的 import するため、IIFE 形式では code-splitting できない。
- Service Worker のキャッシュ対象に Worker の JS と WASM が加わる。
  ビルド成果物は内容ハッシュ付き URL のため cache-first で問題ない。

キャンセル:

- 通常は Worker へ `cancel` メッセージを送り、バッチ境界で停止する。
- `worker.terminate()` は即時停止できるが、途中結果とコア状態を失うため通常は使わない。
- 実行世代番号で、古い実行の完了コールバックを無視する。

### 7.2 不定進捗

Worker 実行中は、メインスレッドへ進捗率を即時反映しない。
`ProgressPanel.setIndeterminate(true)` で以下を切り替える。

- `#progress-bar` に `is-indeterminate` クラスを付与し、CSS アニメーションで流す。
- `aria-busy="true"` と `aria-valuetext` を設定し、`aria-valuenow` を外す。
- ラベルは「生成中…（進捗率は表示できません）」を表示する。
- 完了時は `setIndeterminate(false)` で確定進捗(100%)へ戻す。
- `prefers-reduced-motion` ではアニメーションを止め、バーを静止表示する。

ブラウザ確認では、生成開始時に `is-indeterminate` と `aria-busy="true"` が付き、
完了時にクラスが外れて `aria-valuenow="100"` になることを確認した。

### 7.3 ブラウザ実測

1920x1080、タイル 300 枚、`row_batch = 8` の生成時間(5 回中央値):

| 実装                                     | 中央値 |   最小 |   最大 | JS Worker 比 |
| ---------------------------------------- | -----: | -----: | -----: | -----------: |
| JS Worker                                | 336 ms | 333 ms | 340 ms |            - |
| WASM Worker(`opt-level = 3`、現行)       | 237 ms | 232 ms | 245 ms |      約 -29% |
| WASM Worker(`opt-level = "z"`、最適化前) | 345 ms | 342 ms | 351 ms |       約 +3% |

- 現行の `opt-level = 3` WASM は、Worker 構成では JS より約 29% 速い。
- 最適化前のサイズ優先 WASM は、JS より約 3% 遅かった。
- 現行の `opt-level = 3` WASM は、最適化前の WASM より約 31% 速い。
- 出力 Canvas のサンプルチェックサムは JS Worker と WASM Worker で一致した。
- 現行値は `opt-level = 3` を `web/src/wasm/` に再ビルドしたビルドで計測した。
  `opt-level = "z"` の値は最適化前の記録である。

計測日: 2026-10-20。ウォームアップ後の生値(ms):

| 実装                                     |   1 |   2 |   3 |   4 |   5 | 中央値 |
| ---------------------------------------- | --: | --: | --: | --: | --: | -----: |
| JS Worker                                | 335 | 336 | 336 | 340 | 333 |    336 |
| WASM Worker(`opt-level = 3`、現行)       | 235 | 237 | 232 | 245 | 238 |    237 |
| WASM Worker(`opt-level = "z"`、最適化前) | 351 | 342 | 344 | 349 | 345 |    345 |

### 7.4 ネットワーク確認

- JS 版(`index_js.html`)の取得は、ページ、JS エントリ、共有アプリ、
  CSS、`js.worker` のみ。WASM の JS / バイナリは取得しない。
- WASM 版(`index.html`)は、`wasm.worker`、WASM ローダー、
  `photomosaic_core_wasm_bg.wasm` を取得する。
- 両ページともコンソールに `impl: js-worker` / `impl: wasm-worker` を出力した。
- 両ページとも生成開始時に不定進捗、完了時に 100% 表示になった。

### 7.5 実装上の注意

- transferable で送った `ArrayBuffer` は送信元で detached になる。
  同じバッファを再利用する場合は、送信前にコピーする。
- Worker の `onerror` / `onmessageerror` では保留中の Promise をすべて reject する。
- Worker 初期化失敗時のフォールバックは、アプリ起動を止めないための保険である。
- `setTimeout(0)` は rAF より短いが、バッチ数が多いと待ち時間が積み上がる。
  `row_batch` を大きくするとバッチ数と待ち時間を減らせる。
- 真のマルチスレッド WASM は、配信ヘッダーと P3 の逐次依存の制約が大きいため保留する。

## 8. 再計測時の注意

- Node 上のコア単体計測は、ブラウザの JIT・WASM エンジン・GC の影響と異なる。
- ブラウザの Worker 計測は、Worker RPC、進捗メッセージ、Canvas 描画を含む。
  コア単体の `P3_MATCH` / `P4_COMPOSE` とは異なる値になる。
- 画面全体の体感速度は、画像デコード、サムネイル生成、Canvas 描画も含む。
- 比較するときは、同じ画像・同じタイル・同じ `row_batch` を使う。
- 初回計測はウォームアップを含むため、複数回の中央値で比較する。
- WASM の `opt-level = 3` はサイズを約 9% 増やすが、191,728 bytes で 500 KB 上限以内。
  現在はこの設定を採用し、`web/src/wasm/` も再ビルド済み。
- CI と GitHub Pages は `npm run wasm:build` を使うため、`core-wasm/Cargo.toml` の
  `opt-level = 3` がそのまま適用される。
- 過去の比較計測では dist のアセットを差し替えた。再計測時は WASM ローダーが期待する
  ファイル名と配信 MIME タイプ(`application/wasm`)を確認する。
- Service Worker が古いアセットを返すと計測を誤る。比較時は新しいブラウザプロファイルを使うか、
  Service Worker を登録解除してから再読み込みする。
- `wasm-opt -O3` や SIMD は今回の計測に含めていない。追加の改善余地がある。

## 9. まとめ

- 初期のサイズ優先 WASM は純 TypeScript 実装より遅かった。
- `opt-level = 3` で WASM の計算は改善し、計算のみでは純 TypeScript を上回った。
- メインスレッド版では rAF 待ちにより差が縮む。
- WASM/JS の両方を Web Worker で実行する構成を実装し、rAF 待ちを廃止した。
- 不定進捗により、生成中も UI を止めずに操作を継続できる。
- ブラウザの Worker 実測では、最適化前のサイズ優先 WASM は JS より約 3% 遅く、
  現行の `opt-level = 3` WASM は JS より約 29% 速い。
- `opt-level = 3` を採用し、`core-wasm/Cargo.toml` と `web/src/wasm/` を更新済み。
  CI と GitHub Pages も同じ設定で WASM をビルドする。
- 真のマルチスレッド WASM は配信ヘッダーと P3 の逐次依存の制約が大きい。
