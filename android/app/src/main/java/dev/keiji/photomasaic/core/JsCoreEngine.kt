package dev.keiji.photomasaic.core

import android.content.Context
import android.util.Base64
import android.util.Log
import androidx.javascriptengine.JavaScriptConsoleCallback
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import androidx.javascriptengine.Message
import androidx.javascriptengine.MessagePort
import androidx.javascriptengine.MessagePortClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * AndroidX JavaScriptEngine(サンドボックス)上で WASM コアを実行する実装。
 *
 * - 起動時に `JavaScriptSandbox.isSupported()` と `typeof WebAssembly` を検査する
 * - グルー(wasm-bindgen no-modules ターゲット)と .wasm は assets から読み込む
 * - MessagePort が使える端末では、制御は MessagePort の文字列メッセージで送る。
 *   RGBA は named data で渡し、メッセージは参照(dataRef)のみを持つ
 * - MessagePort が使えない端末では evaluate トランスポートへフォールバックする。
 *   制御は `evaluateJavaScriptAsync`、応答は JS の outbox を `__pmDrain()` で
 *   ポーリングして受け取る。RGBA は base64 チャンクで受ける
 * - 要求と応答は id で対応付け、タイムアウトで失敗させる
 */
@Suppress("TooManyFunctions", "LargeClass")
class JsCoreEngine(
    private val context: Context,
) : CoreEngine {
    private var sandbox: JavaScriptSandbox? = null
    private var isolate: JavaScriptIsolate? = null

    @Volatile
    private var messagePort: MessagePort? = null

    @Volatile
    private var transport = Transport.MESSAGE_PORT

    @Volatile
    private var namedDataAvailable = false
    private var coreVersion: String? = null

    private val messageExecutor =
        Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "js-core-port") }
    private val pendingRequests = ConcurrentHashMap<Long, PendingRequest>()

    // 以下はメッセージ受信スレッド(MessagePort)またはポーラーだけが触る
    private var pendingBinaryRequestId: Long? = null
    private var pendingBatchMeta: BatchMeta? = null
    private var pendingResultMeta: ResultMeta? = null

    // evaluate トランスポート用。ポーラーだけが触る
    private var fallbackBuffer: ByteArray? = null
    private var fallbackOffset = 0
    private var fallbackExpectedLength = 0

    @Volatile
    private var activeGeneration: Channel<GenerationEvent>? = null

    private var nextRequestId = 0L
    private var namedDataCounter = 0L
    private val requestMutex = Mutex()
    private val runMutex = Mutex()
    private val evalMutex = Mutex()
    private val pollScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var pollJob: Job? = null

    // サンドボックス境界では RemoteException / タイムアウト / JS 例外など
    // 多様な失敗を一括で画面状態へ変換するため、Exception 捕捉は意図的。
    @Suppress("TooGenericExceptionCaught", "CyclomaticComplexMethod", "LongMethod")
    override suspend fun start(): CoreStartupResult =
        withContext(Dispatchers.IO) {
            if (!JavaScriptSandbox.isSupported()) {
                return@withContext CoreStartupResult.SandboxUnsupported
            }
            val readyVersion = coreVersion
            if (isolate != null && readyVersion != null) {
                ensurePolling()
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
                val wasmSupported =
                    activeSandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_WASM_COMPILATION)
                val namedDataSupported =
                    activeSandbox.isFeatureSupported(
                        JavaScriptSandbox.JS_FEATURE_PROVIDE_CONSUME_ARRAY_BUFFER,
                    )
                val promiseSupported =
                    activeSandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_PROMISE_RETURN)
                val messagePortSupported =
                    activeSandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_MESSAGE_PORTS)
                val transactionLimitSupported =
                    activeSandbox.isFeatureSupported(
                        JavaScriptSandbox.JS_FEATURE_EVALUATE_WITHOUT_TRANSACTION_LIMIT,
                    )
                val isolateMaxHeapSupported =
                    activeSandbox.isFeatureSupported(
                        JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE,
                    )
                Log.i(
                    LOG_TAG,
                    "features: wasm=$wasmSupported messagePort=$messagePortSupported " +
                        "provideNamedData=$namedDataSupported promise=$promiseSupported " +
                        "evaluateWithoutTransactionLimit=$transactionLimitSupported " +
                        "isolateMaxHeap=$isolateMaxHeapSupported",
                )
                if (!wasmSupported) {
                    return@withContext CoreStartupResult.WebAssemblyUnavailable
                }
                if (!promiseSupported) {
                    return@withContext CoreStartupResult.Failed("Promise return is not supported")
                }

                // 段階的機能低下:
                // MessagePort > named data + evaluate > Base64 evaluate
                // MessagePort 自体がバイナリ入力を持てるため、named data の有無に
                // かかわらず MessagePort を優先する。
                var usePort = messagePortSupported
                if (messagePortSupported && !namedDataSupported) {
                    Log.i(
                        LOG_TAG,
                        "MessagePort is available without named data; " +
                            "using MessagePort binary input",
                    )
                }
                if (usePort) {
                    messagePort =
                        try {
                            activeIsolate.createMessageChannel(
                                CHANNEL_NAME,
                                messageExecutor,
                                MessagePortClient { message -> onPortMessage(message) },
                            )
                        } catch (err: Exception) {
                            Log.w(LOG_TAG, "MessagePort is unavailable; using evaluate transport", err)
                            usePort = false
                            null
                        }
                }
                namedDataAvailable = namedDataSupported
                transport =
                    when {
                        messagePort != null -> Transport.MESSAGE_PORT
                        namedDataSupported -> Transport.NAMED_DATA_EVALUATE
                        else -> Transport.STRING_EVALUATE
                    }

                // ホストスクリプト(UTF-8 ポリフィル + プロトコル)を先に評価し、
                // 次に wasm-bindgen グルーを評価する
                evaluate(activeIsolate, readAssetText(HOST_ASSET))
                evaluate(activeIsolate, readAssetText(GLUE_ASSET))

                namedDataCounter += 1
                val wasmBytes = readAssetBytes(WASM_ASSET)
                val version =
                    if (namedDataSupported) {
                        val wasmRef = "wasm-$namedDataCounter"
                        activeIsolate.provideNamedData(wasmRef, wasmBytes)
                        evaluate(activeIsolate, "__pmInit('$wasmRef', $usePort, true)")
                    } else {
                        val wasmBase64 = Base64.encodeToString(wasmBytes, Base64.NO_WRAP)
                        evaluate(activeIsolate, "__pmInit('$wasmBase64', false, false)")
                    }
                coreVersion = version
                ensurePolling()
                Log.i(LOG_TAG, "core started with ${transport.name.lowercase()} transport")
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
        val result = addTiles(listOf(TileInput(id, feature, compose)))
        return result.tiles.firstOrNull()
            ?: throw CoreException(result.errors.firstOrNull() ?: "tile registration failed")
    }

    override suspend fun addTiles(tiles: List<TileInput>): TileBatchResult {
        if (tiles.isEmpty()) {
            return TileBatchResult(emptyList(), emptyList())
        }
        val response =
            requestJson(
                build = { requestId ->
                    val array = JSONArray()
                    tiles.forEachIndexed { index, tile ->
                        array.put(
                            JSONObject()
                                .put("tileId", tile.id)
                                .put("featureRef", "feature-$requestId-$index")
                                .put("composeRef", "compose-$requestId-$index")
                                .put(
                                    "meta",
                                    JSONObject()
                                        .put("featureWidth", tile.feature.width)
                                        .put("featureHeight", tile.feature.height)
                                        .put("composeWidth", tile.compose.width)
                                        .put("composeHeight", tile.compose.height),
                                ),
                        )
                    }
                    JSONObject()
                        .put("type", "addTiles")
                        .put("tiles", array)
                },
                namedData = { requestId ->
                    tiles.flatMapIndexed { index, tile ->
                        listOf(
                            "feature-$requestId-$index" to tile.feature.data,
                            "compose-$requestId-$index" to tile.compose.data,
                        )
                    }
                },
            )
        val tileArray = response.optJSONArray("tiles") ?: JSONArray()
        val errorArray = response.optJSONArray("errors") ?: JSONArray()
        val infos = List(tileArray.length()) { tileArray.getJSONObject(it).toTileInfo() }
        val errors = List(errorArray.length()) { errorArray.getString(it) }
        return TileBatchResult(infos, errors)
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

    override suspend fun getMetrics(): String {
        val response = requestJson { JSONObject().put("type", "getMetrics") }
        return response.getJSONObject("metrics").toString()
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
            val json = build(id).put("id", id)
            val deferred = CompletableDeferred<JSONObject>()
            pendingRequests[id] = PendingRequest(json = deferred)
            try {
                namedData(id).forEach { (name, bytes) ->
                    provideBinary(name, bytes)
                }
                post(json)
                withTimeout(REQUEST_TIMEOUT_MS) { deferred.await() }
            } finally {
                pendingRequests.remove(id)
            }
        }

    private suspend fun requestBinary(build: (Long) -> JSONObject): ByteArray =
        requestMutex.withLock {
            val id = ++nextRequestId
            val json = build(id).put("id", id)
            val jsonDeferred = CompletableDeferred<JSONObject>()
            val binaryDeferred = CompletableDeferred<ByteArray>()
            pendingRequests[id] = PendingRequest(json = jsonDeferred, binary = binaryDeferred)
            try {
                post(json)
                withTimeout(REQUEST_TIMEOUT_MS) { binaryDeferred.await() }
            } finally {
                pendingRequests.remove(id)
            }
        }

    private fun control(type: String): JSONObject = JSONObject().put("type", type)

    private suspend fun post(json: JSONObject) {
        val port = messagePort
        if (port != null) {
            port.postMessage(Message.createStringMessage(json.toString()))
            return
        }
        ensurePolling()
        sendControl(json)
    }

    private fun postPort(json: JSONObject) {
        val port = messagePort ?: throw CoreException("core is not started")
        port.postMessage(Message.createStringMessage(json.toString()))
    }

    private suspend fun sendControl(json: JSONObject) {
        val activeIsolate = isolate ?: throw CoreException("core is not started")
        val script = "__pmHandleControl(${JSONObject.quote(json.toString())})"
        evalMutex.withLock {
            withContext(Dispatchers.IO) {
                evaluate(activeIsolate, script)
            }
        }
    }

    private suspend fun provideBinary(
        name: String,
        bytes: ByteArray,
    ) {
        if (transport == Transport.STRING_EVALUATE) {
            provideStringInput(name, bytes)
            return
        }
        if (transport == Transport.MESSAGE_PORT && !namedDataAvailable) {
            providePortInput(name, bytes)
            return
        }
        val activeIsolate = isolate ?: throw CoreException("core is not started")
        activeIsolate.provideNamedData(name, bytes)
    }

    private suspend fun provideStringInput(
        name: String,
        bytes: ByteArray,
    ) {
        sendControl(
            JSONObject()
                .put("type", "inputBegin")
                .put("id", name)
                .put("length", bytes.size),
        )
        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(offset + INPUT_CHUNK_BYTES, bytes.size)
            sendControl(
                JSONObject()
                    .put("type", "inputChunk")
                    .put("id", name)
                    .put("data", Base64.encodeToString(bytes.copyOfRange(offset, end), Base64.NO_WRAP)),
            )
            offset = end
        }
    }

    private fun providePortInput(
        name: String,
        bytes: ByteArray,
    ) {
        val port = messagePort ?: throw CoreException("core is not started")
        port.postMessage(
            Message.createStringMessage(
                JSONObject()
                    .put("type", "inputBegin")
                    .put("id", name)
                    .put("length", bytes.size)
                    .toString(),
            ),
        )
        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(offset + INPUT_CHUNK_BYTES, bytes.size)
            port.postMessage(Message.createArrayBufferMessage(bytes.copyOfRange(offset, end)))
            offset = end
        }
    }

    private suspend fun sendCancel() {
        runCatching { post(JSONObject().put("type", "cancel")) }
            .onFailure { Log.w(LOG_TAG, "failed to send cancel", it) }
    }

    @Synchronized
    private fun ensurePolling() {
        if (transport == Transport.MESSAGE_PORT) {
            return
        }
        if (pollJob?.isActive == true) {
            return
        }
        pollJob = pollScope.launch { pollLoop() }
    }

    @Suppress("TooGenericExceptionCaught")
    private suspend fun pollLoop() {
        while (currentCoroutineContext().isActive) {
            val activeIsolate = isolate
            if (activeIsolate == null) {
                delay(IDLE_POLL_MS)
                continue
            }
            val hasWork = pendingRequests.isNotEmpty() || activeGeneration != null
            try {
                val raw =
                    evalMutex.withLock {
                        withContext(Dispatchers.IO) {
                            evaluate(activeIsolate, "__pmDrain()")
                        }
                    }
                val entry = JSONObject(raw)
                if (entry.optString("k") == "empty") {
                    delay(if (hasWork) ACTIVE_POLL_MS else IDLE_POLL_MS)
                } else {
                    handleFallbackEntry(entry)
                }
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                Log.e(LOG_TAG, "failed to drain evaluate transport", err)
                failPending(err)
                delay(IDLE_POLL_MS)
            }
        }
    }

    private suspend fun handleFallbackEntry(entry: JSONObject) {
        when (entry.optString("k")) {
            "json" -> {
                val json = entry.getJSONObject("v")
                val type = json.optString("type")
                if (type == "stepDone") {
                    if (activeGeneration != null) {
                        sendControl(control("step"))
                    }
                } else {
                    handleTextMessage(json.toString(), allowStep = false)
                    if (type == "batchDone" && pendingBatchMeta?.length == 0) {
                        completeFallbackBinary()
                    } else if (type == "result" && pendingResultMeta?.length == 0) {
                        completeFallbackBinary()
                    }
                }
            }
            "chunk" -> appendFallbackChunk(entry.getString("d"))
            "empty" -> Unit
            else -> Log.w(LOG_TAG, "unknown fallback entry: ${entry.optString("k")}")
        }
    }

    private fun prepareFallbackBuffer(length: Int) {
        fallbackExpectedLength = length
        fallbackOffset = 0
        fallbackBuffer = if (length > 0) ByteArray(length) else null
    }

    private fun resetFallbackBuffer() {
        fallbackBuffer = null
        fallbackOffset = 0
        fallbackExpectedLength = 0
    }

    private fun appendFallbackChunk(data: String) {
        appendBinaryChunk(Base64.decode(data, Base64.DEFAULT))
    }

    private fun appendBinaryChunk(decoded: ByteArray) {
        val expected = fallbackExpectedLength
        if (expected < 0) {
            throw CoreException("binary response length is missing")
        }
        val buffer = fallbackBuffer ?: ByteArray(expected).also { fallbackBuffer = it }
        if (fallbackOffset + decoded.size > expected) {
            throw CoreException("binary response is larger than declared length")
        }
        decoded.copyInto(buffer, fallbackOffset)
        fallbackOffset += decoded.size
        if (fallbackOffset >= expected) {
            completeFallbackBinary()
        }
    }

    @Suppress("ReturnCount")
    private fun completeFallbackBinary() {
        val expected = fallbackExpectedLength
        val buffer = fallbackBuffer
        val offset = fallbackOffset
        resetFallbackBuffer()
        val bytes =
            when {
                expected == 0 -> ByteArray(0)
                buffer == null -> ByteArray(0)
                offset == expected -> buffer
                else -> buffer.copyOf(offset)
            }

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

    private fun failPending(err: Exception) {
        val error = CoreException(err.message ?: "evaluate transport failed")
        pendingRequests.values.forEach { pending ->
            pending.json.completeExceptionally(error)
            pending.binary?.completeExceptionally(error)
        }
        pendingRequests.clear()
        pendingBinaryRequestId = null
        pendingBatchMeta = null
        pendingResultMeta = null
        resetFallbackBuffer()
        activeGeneration?.trySend(GenerationEvent.Failed(error.message ?: "evaluate transport failed"))
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

    private fun handleTextMessage(
        text: String,
        allowStep: Boolean = true,
    ) {
        val json = JSONObject(text)
        when (json.optString("type")) {
            "response" -> handleResponse(json)
            "progress" -> handleProgress(json)
            "batchDone" -> {
                val length = json.optInt("length", -1)
                pendingBatchMeta =
                    BatchMeta(
                        rowBegin = json.getInt("row_begin"),
                        rowEnd = json.getInt("row_end"),
                        blockSize = json.getInt("block_size"),
                        width = json.getInt("width"),
                        length = length,
                    )
                prepareFallbackBuffer(length)
                if (length == 0) {
                    completeFallbackBinary()
                }
            }
            "result" -> {
                val length = json.optInt("length", -1)
                pendingResultMeta =
                    ResultMeta(
                        width = json.getInt("width"),
                        height = json.getInt("height"),
                        length = length,
                    )
                prepareFallbackBuffer(length)
                if (length == 0) {
                    completeFallbackBinary()
                }
            }
            "error" ->
                activeGeneration?.trySend(
                    GenerationEvent.Failed(json.optString("message", "core execution failed")),
                )
            "canceled" -> activeGeneration?.trySend(GenerationEvent.Canceled)
            "stepDone" -> {
                if (allowStep && messagePort != null) {
                    postPort(control("step"))
                }
            }
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
            val length = json.optInt("length", 0)
            pendingBinaryRequestId = id
            prepareFallbackBuffer(length)
            if (length == 0) {
                pendingBinaryRequestId = null
                pendingRequests.remove(id)?.binary?.complete(ByteArray(0))
            }
            return
        }
        pendingRequests.remove(id)
        pending.json.complete(json)
    }

    private fun handleBinaryMessage(bytes: ByteArray) {
        appendBinaryChunk(bytes)
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
        stopPolling()
        messagePort?.close()
        messagePort = null
        isolate?.close()
        isolate = null
        coreVersion = null
        transport = Transport.MESSAGE_PORT
        pendingBinaryRequestId = null
        pendingBatchMeta = null
        pendingResultMeta = null
        resetFallbackBuffer()
    }

    private fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
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
        pollScope.cancel()
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
        val length: Int,
    )

    private data class ResultMeta(
        val width: Int,
        val height: Int,
        val length: Int,
    )

    private enum class Transport {
        MESSAGE_PORT,
        NAMED_DATA_EVALUATE,
        STRING_EVALUATE,
    }

    private companion object {
        const val LOG_TAG = "JsCoreEngine"
        const val TIMEOUT_SECONDS = 30L
        const val REQUEST_TIMEOUT_MS = 60_000L
        const val ACTIVE_POLL_MS = 16L
        const val IDLE_POLL_MS = 50L
        const val INPUT_CHUNK_BYTES = 512 * 1024
        const val CHANNEL_NAME = "core"
        const val GLUE_ASSET = "core/photomosaic_core_wasm.js"
        const val WASM_ASSET = "core/photomosaic_core_wasm_bg.wasm"
        const val HOST_ASSET = "host/host.js"
    }
}
