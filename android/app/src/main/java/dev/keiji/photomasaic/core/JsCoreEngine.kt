package dev.keiji.photomasaic.core

import android.content.Context
import android.util.Log
import androidx.javascriptengine.JavaScriptConsoleCallback
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import androidx.javascriptengine.Message
import androidx.javascriptengine.MessagePort
import androidx.javascriptengine.MessagePortClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * AndroidX JavaScriptEngine(サンドボックス)上で WASM コアを実行する実装。
 *
 * - 起動時に `JavaScriptSandbox.isSupported()` と `typeof WebAssembly` を検査する
 * - グルー(wasm-bindgen no-modules ターゲット)と .wasm は assets から読み込む
 * - Kotlin → JS の制御は MessagePort の文字列メッセージ。RGBA は named data で渡し、
 *   メッセージは参照(dataRef)のみを持つ
 * - JS → Kotlin の進捗・部分結果・完成画像は MessagePort の文字列 + ArrayBuffer で受ける
 * - 要求と応答は id で対応付け、タイムアウトで失敗させる
 */
@Suppress("TooManyFunctions")
class JsCoreEngine(
    private val context: Context,
) : CoreEngine {
    private var sandbox: JavaScriptSandbox? = null
    private var isolate: JavaScriptIsolate? = null

    @Volatile
    private var messagePort: MessagePort? = null
    private var coreVersion: String? = null

    private val messageExecutor =
        Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "js-core-port") }
    private val pendingRequests = ConcurrentHashMap<Long, PendingRequest>()

    // 以下はメッセージ受信スレッド(単一スレッド)だけが触る
    private var pendingBinaryRequestId: Long? = null
    private var pendingBatchMeta: BatchMeta? = null
    private var pendingResultMeta: ResultMeta? = null

    @Volatile
    private var activeGeneration: Channel<GenerationEvent>? = null

    private var nextRequestId = 0L
    private var namedDataCounter = 0L
    private val requestMutex = Mutex()
    private val runMutex = Mutex()

    // サンドボックス境界では RemoteException / タイムアウト / JS 例外など
    // 多様な失敗を一括で画面状態へ変換するため、Exception 捕捉は意図的。
    @Suppress("TooGenericExceptionCaught", "CyclomaticComplexMethod")
    override suspend fun start(): CoreStartupResult =
        withContext(Dispatchers.IO) {
            if (!JavaScriptSandbox.isSupported()) {
                return@withContext CoreStartupResult.SandboxUnsupported
            }
            val readyVersion = coreVersion
            if (isolate != null && readyVersion != null) {
                return@withContext CoreStartupResult.Ready(readyVersion)
            }
            try {
                val activeSandbox = sandbox ?: createSandbox().also { sandbox = it }
                closeIsolate()
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
                if (!activeSandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_MESSAGE_PORTS)) {
                    return@withContext CoreStartupResult.Failed("MessagePort is not supported")
                }

                // ホスト JS が参照する MessagePort を先に用意する。
                // ハンドラ設定は __pmInit 内で行い、その完了を待ってから制御を送る。
                messagePort =
                    activeIsolate.createMessageChannel(
                        CHANNEL_NAME,
                        messageExecutor,
                        MessagePortClient { message -> onPortMessage(message) },
                    )

                // ホストスクリプト(UTF-8 ポリフィル + プロトコル)を先に評価し、
                // 次に wasm-bindgen グルーを評価する
                evaluate(activeIsolate, readAssetText(HOST_ASSET))
                evaluate(activeIsolate, readAssetText(GLUE_ASSET))

                namedDataCounter += 1
                val wasmRef = "wasm-$namedDataCounter"
                activeIsolate.provideNamedData(wasmRef, readAssetBytes(WASM_ASSET))
                val version = evaluate(activeIsolate, "__pmInit('$wasmRef')")
                coreVersion = version
                CoreStartupResult.Ready(version)
            } catch (err: Exception) {
                closeIsolate()
                CoreStartupResult.Failed(err.message ?: err.javaClass.simpleName)
            }
        }

    override suspend fun setMainImage(image: RgbaImage): GridInfo {
        val response =
            requestJson(
                build = { id ->
                    JSONObject()
                        .put("type", "setMainImage")
                        .put("dataRef", "main-$id")
                        .put(
                            "meta",
                            JSONObject()
                                .put("width", image.width)
                                .put("height", image.height),
                        )
                },
                namedData = { id -> listOf("main-$id" to image.data) },
            )
        return response.getJSONObject("grid").toGridInfo()
    }

    override suspend fun setBlockSize(px: Int): GridInfo {
        val response =
            requestJson { JSONObject().put("type", "setBlockSize").put("px", px) }
        return response.getJSONObject("grid").toGridInfo()
    }

    override suspend fun getBlockMeanColors(): ByteArray = requestBinary { control("getBlockMeanColors") }

    override suspend fun addTile(
        id: Long,
        feature: RgbaImage,
        compose: RgbaImage,
    ): TileInfo {
        val response =
            requestJson(
                build = { requestId ->
                    JSONObject()
                        .put("type", "addTile")
                        .put("tileId", id)
                        .put("featureRef", "feature-$requestId")
                        .put("composeRef", "compose-$requestId")
                        .put(
                            "meta",
                            JSONObject()
                                .put("featureWidth", feature.width)
                                .put("featureHeight", feature.height)
                                .put("composeWidth", compose.width)
                                .put("composeHeight", compose.height),
                        )
                },
                namedData = { requestId ->
                    listOf(
                        "feature-$requestId" to feature.data,
                        "compose-$requestId" to compose.data,
                    )
                },
            )
        return response.getJSONObject("tile").toTileInfo()
    }

    override suspend fun removeTile(id: Long) {
        requestJson { JSONObject().put("type", "removeTile").put("tileId", id) }
    }

    override suspend fun clearTiles() {
        requestJson { JSONObject().put("type", "clearTiles") }
    }

    override suspend fun clearMainImage() {
        requestJson { JSONObject().put("type", "clearMainImage") }
    }

    override fun run(): Flow<GenerationEvent> = generate("run")

    override fun rematch(): Flow<GenerationEvent> = generate("rematch")

    override suspend fun cancel() {
        sendCancel()
    }

    override suspend fun getConfig(): MosaicConfig {
        val response = requestJson { JSONObject().put("type", "getConfig") }
        return MosaicConfig.fromJson(response.getJSONObject("config"))
    }

    override suspend fun setConfig(config: MosaicConfig) {
        requestJson {
            JSONObject()
                .put("type", "setConfig")
                .put("config", config.toJson())
        }
    }

    private fun generate(type: String): Flow<GenerationEvent> =
        flow {
            runMutex.withLock {
                val channel = Channel<GenerationEvent>(Channel.UNLIMITED)
                activeGeneration = channel
                try {
                    post(JSONObject().put("type", type))
                    for (event in channel) {
                        emit(event)
                        if (event is GenerationEvent.Completed ||
                            event is GenerationEvent.Canceled ||
                            event is GenerationEvent.Failed
                        ) {
                            break
                        }
                    }
                } catch (err: CancellationException) {
                    sendCancel()
                    throw err
                } finally {
                    activeGeneration = null
                    channel.close()
                }
            }
        }

    private suspend fun requestJson(
        namedData: (Long) -> List<Pair<String, ByteArray>> = { emptyList() },
        build: (Long) -> JSONObject,
    ): JSONObject =
        requestMutex.withLock {
            val id = ++nextRequestId
            val json = build(id)
            val deferred = CompletableDeferred<JSONObject>()
            pendingRequests[id] = PendingRequest(json = deferred)
            namedData(id).forEach { (name, bytes) ->
                val activeIsolate = isolate ?: throw CoreException("core is not started")
                activeIsolate.provideNamedData(name, bytes)
            }
            post(json)
            try {
                withTimeout(REQUEST_TIMEOUT_MS) { deferred.await() }
            } finally {
                pendingRequests.remove(id)
            }
        }

    private suspend fun requestBinary(build: (Long) -> JSONObject): ByteArray =
        requestMutex.withLock {
            val id = ++nextRequestId
            val json = build(id)
            val jsonDeferred = CompletableDeferred<JSONObject>()
            val binaryDeferred = CompletableDeferred<ByteArray>()
            pendingRequests[id] = PendingRequest(json = jsonDeferred, binary = binaryDeferred)
            post(json)
            try {
                withTimeout(REQUEST_TIMEOUT_MS) { binaryDeferred.await() }
            } finally {
                pendingRequests.remove(id)
            }
        }

    private fun control(type: String): JSONObject = JSONObject().put("type", type)

    private fun post(json: JSONObject) {
        val port = messagePort ?: throw CoreException("core is not started")
        port.postMessage(Message.createStringMessage(json.toString()))
    }

    private fun sendCancel() {
        runCatching { post(JSONObject().put("type", "cancel")) }
            .onFailure { Log.w(LOG_TAG, "failed to send cancel", it) }
    }

    @Suppress("TooGenericExceptionCaught")
    private fun onPortMessage(message: Message) {
        try {
            when (message.type) {
                Message.TYPE_STRING -> handleTextMessage(message.string)
                Message.TYPE_ARRAY_BUFFER -> handleBinaryMessage(message.arrayBuffer)
                else -> Log.w(LOG_TAG, "unsupported message type: ${message.type}")
            }
        } catch (err: Exception) {
            Log.e(LOG_TAG, "failed to handle core message", err)
            activeGeneration?.trySend(
                GenerationEvent.Failed(err.message ?: "message handling failed"),
            )
        }
    }

    private fun handleTextMessage(text: String) {
        val json = JSONObject(text)
        when (json.optString("type")) {
            "response" -> handleResponse(json)
            "progress" -> handleProgress(json)
            "batchDone" -> {
                pendingBatchMeta =
                    BatchMeta(
                        rowBegin = json.getInt("row_begin"),
                        rowEnd = json.getInt("row_end"),
                        blockSize = json.getInt("block_size"),
                        width = json.getInt("width"),
                    )
            }
            "result" -> {
                pendingResultMeta =
                    ResultMeta(
                        width = json.getInt("width"),
                        height = json.getInt("height"),
                    )
            }
            "error" ->
                activeGeneration?.trySend(
                    GenerationEvent.Failed(json.optString("message", "core execution failed")),
                )
            "canceled" -> activeGeneration?.trySend(GenerationEvent.Canceled)
            "stepDone" -> post(JSONObject().put("type", "step"))
            else -> Log.w(LOG_TAG, "unknown message type: ${json.optString("type")}")
        }
    }

    @Suppress("ReturnCount")
    private fun handleResponse(json: JSONObject) {
        val id = json.optLong("id", -1L)
        if (id < 0) {
            return
        }
        val pending = pendingRequests[id] ?: return
        if (!json.optBoolean("ok", false)) {
            val error = CoreException(json.optString("error", "core request failed"))
            pendingRequests.remove(id)
            pending.json.completeExceptionally(error)
            pending.binary?.completeExceptionally(error)
            return
        }
        if (json.optBoolean("binary", false)) {
            pendingBinaryRequestId = id
            return
        }
        pendingRequests.remove(id)
        pending.json.complete(json)
    }

    @Suppress("ReturnCount")
    private fun handleBinaryMessage(bytes: ByteArray) {
        val binaryId = pendingBinaryRequestId
        if (binaryId != null) {
            pendingBinaryRequestId = null
            pendingRequests.remove(binaryId)?.binary?.complete(bytes)
            return
        }
        pendingBatchMeta?.let { meta ->
            pendingBatchMeta = null
            activeGeneration?.trySend(
                GenerationEvent.Batch(
                    ResultBatch(
                        blockRowBegin = meta.rowBegin,
                        blockRowEnd = meta.rowEnd,
                        blockSize = meta.blockSize,
                        width = meta.width,
                        rgba = bytes,
                    ),
                ),
            )
            return
        }
        pendingResultMeta?.let { meta ->
            pendingResultMeta = null
            activeGeneration?.trySend(
                GenerationEvent.Completed(RgbaImage(meta.width, meta.height, bytes)),
            )
        }
    }

    private fun handleProgress(json: JSONObject) {
        activeGeneration?.trySend(
            GenerationEvent.Progress(
                ProgressEvent(
                    phaseCode = json.getString("phase_code"),
                    phaseRatio = json.getDouble("phase_ratio").toFloat(),
                    overallRatio = json.getDouble("overall_ratio").toFloat(),
                    assignedBlocks = json.getInt("assigned_blocks"),
                    totalBlocks = json.getInt("total_blocks"),
                ),
            ),
        )
    }

    private fun createSandbox(): JavaScriptSandbox =
        JavaScriptSandbox.createConnectedInstanceAsync(context).get(TIMEOUT_SECONDS, TimeUnit.SECONDS)

    /** サンドボックス内の console 出力を Logcat へ流す(原因調査用) */
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

    private fun closeIsolate() {
        messagePort?.close()
        messagePort = null
        isolate?.close()
        isolate = null
        coreVersion = null
    }

    override fun close() {
        activeGeneration?.close()
        activeGeneration = null
        pendingRequests.values.forEach { pending ->
            pending.json.cancel()
            pending.binary?.cancel()
        }
        pendingRequests.clear()
        closeIsolate()
        sandbox?.close()
        sandbox = null
        messageExecutor.shutdown()
    }

    private data class PendingRequest(
        val json: CompletableDeferred<JSONObject>,
        val binary: CompletableDeferred<ByteArray>? = null,
    )

    private data class BatchMeta(
        val rowBegin: Int,
        val rowEnd: Int,
        val blockSize: Int,
        val width: Int,
    )

    private data class ResultMeta(
        val width: Int,
        val height: Int,
    )

    private companion object {
        const val LOG_TAG = "JsCoreEngine"
        const val TIMEOUT_SECONDS = 30L
        const val REQUEST_TIMEOUT_MS = 60_000L
        const val CHANNEL_NAME = "core"
        const val GLUE_ASSET = "core/photomosaic_core_wasm.js"
        const val WASM_ASSET = "core/photomosaic_core_wasm_bg.wasm"
        const val HOST_ASSET = "host/host.js"
    }
}
