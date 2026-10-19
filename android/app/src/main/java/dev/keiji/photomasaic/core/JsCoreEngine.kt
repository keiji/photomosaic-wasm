package dev.keiji.photomasaic.core

import android.content.Context
import android.util.Log
import androidx.javascriptengine.JavaScriptConsoleCallback
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * AndroidX JavaScriptEngine(サンドボックス)上で WASM コアを起動する(A0)。
 *
 * - 起動時に `JavaScriptSandbox.isSupported()` と `typeof WebAssembly` を検査する
 * - グルー(wasm-bindgen no-modules ターゲット)と .wasm は assets から読み込む。
 *   .wasm 本体は Web と同一の成果物を使う
 * - .wasm は `provideNamedData` で isolate へ渡し、ホストスクリプトが
 *   `consumeNamedDataAsArrayBuffer` → `WebAssembly.compile` → `initSync` する
 * - サンドボックスはアプリと別プロセスで動くため、処理中も UI スレッドを塞がない
 */
class JsCoreEngine(
    private val context: Context,
) : CoreEngine {
    private var sandbox: JavaScriptSandbox? = null
    private var isolate: JavaScriptIsolate? = null
    private var namedDataCounter = 0

    // サンドボックス境界では RemoteException / タイムアウト / JS 例外など
    // 多様な失敗を一括で画面状態へ変換するため、Exception 捕捉は意図的。
    @Suppress("TooGenericExceptionCaught")
    override suspend fun start(): CoreStartupResult =
        withContext(Dispatchers.IO) {
            if (!JavaScriptSandbox.isSupported()) {
                return@withContext CoreStartupResult.SandboxUnsupported
            }
            try {
                val activeSandbox = sandbox ?: createSandbox().also { sandbox = it }
                // 再試行時は前の isolate を破棄して新しい実行環境を作る
                isolate?.close()
                val activeIsolate = activeSandbox.createIsolate().also { isolate = it }
                attachConsoleLogging(activeSandbox, activeIsolate)

                val wasmType = evaluate(activeIsolate, "typeof WebAssembly")
                if (wasmType != "object" && wasmType != "function") {
                    return@withContext CoreStartupResult.WebAssemblyUnavailable
                }
                if (!activeSandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_WASM_COMPILATION)) {
                    return@withContext CoreStartupResult.WebAssemblyUnavailable
                }
                if (!activeSandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_PROVIDE_CONSUME_ARRAY_BUFFER)) {
                    return@withContext CoreStartupResult.Failed("named data (ArrayBuffer) is not supported")
                }
                if (!activeSandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_PROMISE_RETURN)) {
                    return@withContext CoreStartupResult.Failed("Promise return is not supported")
                }

                // ホストスクリプト(UTF-8 ポリフィル + 初期化関数)を先に評価し、
                // 次に wasm-bindgen グルーを評価する
                evaluate(activeIsolate, readAssetText(HOST_ASSET))
                evaluate(activeIsolate, readAssetText(GLUE_ASSET))

                namedDataCounter += 1
                val wasmRef = "wasm-$namedDataCounter"
                activeIsolate.provideNamedData(wasmRef, readAssetBytes(WASM_ASSET))

                val version = evaluate(activeIsolate, "__pmInit('$wasmRef')")
                CoreStartupResult.Ready(version)
            } catch (err: Exception) {
                CoreStartupResult.Failed(err.message ?: err.javaClass.simpleName)
            }
        }

    private fun createSandbox(): JavaScriptSandbox =
        JavaScriptSandbox.createConnectedInstanceAsync(context).get(TIMEOUT_SECONDS, TimeUnit.SECONDS)

    /** サンドボックス内の console 出力を Logcat へ流す(起動失敗の原因調査用) */
    private fun attachConsoleLogging(
        sandbox: JavaScriptSandbox,
        isolate: JavaScriptIsolate,
    ) {
        if (!sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_CONSOLE_MESSAGING)) {
            return
        }
        isolate.setConsoleCallback(
            JavaScriptConsoleCallback { message ->
                if (message.level >= JavaScriptConsoleCallback.ConsoleMessage.LEVEL_ERROR) {
                    Log.e(LOG_TAG, message.message)
                } else {
                    Log.d(LOG_TAG, message.message)
                }
            },
        )
    }

    private fun evaluate(
        isolate: JavaScriptIsolate,
        script: String,
    ): String = isolate.evaluateJavaScriptAsync(script).get(TIMEOUT_SECONDS, TimeUnit.SECONDS)

    private fun readAssetText(path: String): String =
        context.assets
            .open(path)
            .bufferedReader()
            .use { it.readText() }

    private fun readAssetBytes(path: String): ByteArray = context.assets.open(path).use { it.readBytes() }

    override fun close() {
        isolate?.close()
        isolate = null
        sandbox?.close()
        sandbox = null
    }

    private companion object {
        const val LOG_TAG = "JsCoreEngine"
        const val TIMEOUT_SECONDS = 15L
        const val GLUE_ASSET = "core/photomosaic_core_wasm.js"
        const val WASM_ASSET = "core/photomosaic_core_wasm_bg.wasm"
        const val HOST_ASSET = "host/host.js"
    }
}
