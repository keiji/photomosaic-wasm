package dev.keiji.photomasaic.ui.editor

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.keiji.photomasaic.core.CoreEngine
import dev.keiji.photomasaic.core.GenerationEvent
import dev.keiji.photomasaic.core.GridInfo
import dev.keiji.photomasaic.core.MosaicConfig
import dev.keiji.photomasaic.core.ProgressEvent
import dev.keiji.photomasaic.core.ResultBatch
import dev.keiji.photomasaic.core.RgbaImage
import dev.keiji.photomasaic.core.TileInput
import dev.keiji.photomasaic.io.AndroidImageLoader
import dev.keiji.photomasaic.io.ImageExporter
import dev.keiji.photomasaic.io.ImageLoadException
import dev.keiji.photomasaic.io.ImageLoader
import dev.keiji.photomasaic.io.MAX_BLOCK_SIZE
import dev.keiji.photomasaic.io.MIN_BLOCK_SIZE
import dev.keiji.photomasaic.io.argbToRgba
import dev.keiji.photomasaic.io.autoBlockSizeForSmallImage
import dev.keiji.photomasaic.io.bitmapToRgba
import dev.keiji.photomasaic.io.rgbaToBitmap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.Locale
import kotlin.math.roundToInt

/** 初期ブロックサイズ(基本設計書 2.2 の既定値) */
private const val DEFAULT_BLOCK_SIZE = 24

/** 画面に表示するメイン画像(正規化済み) */
data class MainImageUi(
    val bitmap: Bitmap,
    val width: Int,
    val height: Int,
    val scaled: Boolean,
)

/** 画面に表示するタイル 1 枚 */
data class TileUi(
    val id: Long,
    val bitmap: Bitmap,
)

/** 画像読み込み・コア呼び出しの失敗種別(UI 層が文言へ変換する) */
enum class EditorError {
    DecodeFailed,
    CoreFailed,
}

/** S1/S2 の画面 */
enum class EditorStage {
    Start,
    Edit,
}

/** 生成の進捗表示(A2) */
data class GenerationProgressUi(
    val phaseCode: String,
    val phaseRatio: Float,
    val overallRatio: Float,
    val assignedBlocks: Int,
    val totalBlocks: Int,
)

/** 合成終了時に表示するメトリクス(表示用サマリとコピー用の元 JSON) */
data class MetricsUi(
    val summary: String,
    val rawJson: String,
)

/** 操作結果の通知(A2) */
enum class EditorNotice {
    GenerationFailed,
    Canceled,
    SaveSucceeded,
    SaveFailed,
    ShareFailed,
    StoragePermissionDenied,
}

/** S1 開始画面・S2 編集画面の状態(A1/A2) */
data class EditorUiState(
    val coreVersion: String,
    val screen: EditorStage = EditorStage.Start,
    val mainImage: MainImageUi? = null,
    val tiles: List<TileUi> = emptyList(),
    val loading: Loading? = null,
    val error: EditorError? = null,
    val grid: GridInfo? = null,
    val preview: Bitmap? = null,
    val previewRevision: Long = 0,
    val progress: GenerationProgressUi? = null,
    val metrics: MetricsUi? = null,
    val generating: Boolean = false,
    val resultReady: Boolean = false,
    val saving: Boolean = false,
    val config: MosaicConfig? = null,
    val blockSize: Int = DEFAULT_BLOCK_SIZE,
    val blockSizeAdjustedTo: Int? = null,
    val progressExpanded: Boolean = true,
    val tilesLimitReached: Boolean = false,
    val notice: EditorNotice? = null,
    val shareIntent: Intent? = null,
) {
    /** タイル読み込みの進捗(処理済み / 受け付け数) */
    data class Loading(
        val processed: Int,
        val total: Int,
    )
}

/** 画面操作のコールバック(A2) */
data class EditorActions(
    val onMainImageSelected: (Uri) -> Unit = {},
    val onTilesSelected: (List<Uri>, Boolean) -> Unit = { _, _ -> },
    val onRemoveTile: (Long) -> Unit = {},
    val onStartEdit: () -> Unit = {},
    val onBack: () -> Unit = {},
    val onBlockSizeDraft: (Int) -> Unit = {},
    val onBlockSizeCommit: (Int) -> Unit = {},
    val onMainBlendDraft: (Float) -> Unit = {},
    val onColorCorrectDraft: (Float) -> Unit = {},
    val onDuplicateDeDraft: (Float) -> Unit = {},
    val onConfigCommit: () -> Unit = {},
    val onCancel: () -> Unit = {},
    val onSave: () -> Unit = {},
    val onShare: () -> Unit = {},
    val onShareHandled: () -> Unit = {},
    val onToggleProgress: () -> Unit = {},
    val onStoragePermissionDenied: () -> Unit = {},
    val onDismissNotice: () -> Unit = {},
    val onDismissMetrics: () -> Unit = {},
)

/**
 * S1 開始画面・S2 編集画面の状態を保持する ViewModel(A1/A2)。
 * 画像の選択・デコード・一覧管理に加え、コアの生成フロー(進捗・部分結果・
 * 完成画像)を購読し、プレビュー用 Bitmap と進捗を状態へ反映する。
 */
@Suppress("TooManyFunctions", "TooGenericExceptionCaught", "LargeClass")
class EditorViewModel(
    private val coreVersion: String,
    private val core: CoreEngine,
    private val imageLoader: ImageLoader,
    private val exporter: ImageExporter,
    private val progressPreferences: ProgressPreferences,
) : ViewModel() {
    private val _uiState =
        MutableStateFlow(
            EditorUiState(
                coreVersion = coreVersion,
                progressExpanded = progressPreferences.isExpanded(),
            ),
        )
    val uiState: StateFlow<EditorUiState> = _uiState.asStateFlow()

    private var nextTileId = 0L
    private var generationJob: Job? = null
    private var generationToken = 0
    private var blockSizeJob: Job? = null
    private var resultBitmap: Bitmap? = null
    private var gridPreview: Bitmap? = null
    private var mosaicBitmap: Bitmap? = null
    private var sessionToken = 0

    /** メイン画像を選択・変更する */
    @Suppress("LongMethod")
    fun setMainImage(uri: Uri) {
        val session = sessionToken
        stopGeneration(notify = false)
        viewModelScope.launch {
            _uiState.update { it.copy(error = null, notice = null) }
            try {
                val loaded = imageLoader.loadMainImage(uri)
                val rgba =
                    withContext(Dispatchers.Default) {
                        bitmapToRgba(loaded.bitmap)
                    }
                var grid =
                    core.setMainImage(
                        RgbaImage(loaded.width, loaded.height, rgba),
                    )
                val adjustedBlockSize =
                    autoBlockSizeForSmallImage(
                        width = loaded.width,
                        height = loaded.height,
                        blockSize = grid.blockSize,
                    )
                if (adjustedBlockSize != null) {
                    grid = core.setBlockSize(adjustedBlockSize)
                }
                val meanColors = core.getBlockMeanColors()
                val preview =
                    withContext(Dispatchers.Default) {
                        meanColorsBitmap(grid, meanColors)
                    }
                if (session != sessionToken) {
                    return@launch
                }
                gridPreview = preview
                resultBitmap = null
                mosaicBitmap = null
                _uiState.update {
                    it.copy(
                        mainImage =
                            MainImageUi(
                                bitmap = loaded.bitmap,
                                width = loaded.width,
                                height = loaded.height,
                                scaled = loaded.scaled,
                            ),
                        grid = grid,
                        blockSize = grid.blockSize,
                        blockSizeAdjustedTo = adjustedBlockSize,
                        preview = preview,
                        previewRevision = it.previewRevision + 1,
                        progress = null,
                        resultReady = false,
                    )
                }
                if (_uiState.value.screen == EditorStage.Edit &&
                    _uiState.value.tiles.isNotEmpty()
                ) {
                    startGeneration(rematch = false)
                }
            } catch (err: Exception) {
                Log.e(LOG_TAG, "failed to load main image", err)
                _uiState.update { it.copy(error = EditorError.DecodeFailed) }
            }
        }
    }

    /** 構成画像をまとめて追加する(デコード後にコアへ一括登録する) */
    @Suppress("ComplexCondition", "LongMethod")
    fun addTiles(
        uris: List<Uri>,
        limitReached: Boolean = false,
    ) {
        if (uris.isEmpty() || _uiState.value.loading != null) {
            return
        }
        val session = sessionToken
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    error = null,
                    loading = EditorUiState.Loading(0, uris.size),
                    tilesLimitReached = limitReached,
                )
            }
            val inputs = mutableListOf<TileInput>()
            val tiles = mutableListOf<TileUi>()
            var processed = 0
            for (uri in uris) {
                try {
                    val loaded = imageLoader.loadTile(uri)
                    val feature = argbToRgba(loaded.feature)
                    val compose = bitmapToRgba(loaded.compose)
                    nextTileId += 1
                    inputs +=
                        TileInput(
                            id = nextTileId,
                            feature = RgbaImage(FEATURE_SIZE, FEATURE_SIZE, feature),
                            compose =
                                RgbaImage(
                                    loaded.compose.width,
                                    loaded.compose.height,
                                    compose,
                                ),
                        )
                    tiles += TileUi(id = nextTileId, bitmap = loaded.compose)
                } catch (err: ImageLoadException) {
                    Log.e(LOG_TAG, "failed to load tile", err)
                    _uiState.update { it.copy(error = EditorError.DecodeFailed) }
                }
                processed += 1
                _uiState.update { it.copy(loading = EditorUiState.Loading(processed, uris.size)) }
            }
            if (session != sessionToken) {
                return@launch
            }
            if (inputs.isNotEmpty()) {
                try {
                    val result = core.addTiles(inputs)
                    result.errors.forEach { Log.e(LOG_TAG, "failed to add tile: $it") }
                    if (result.errors.isNotEmpty()) {
                        _uiState.update { it.copy(error = EditorError.CoreFailed) }
                    }
                    val byId = tiles.associateBy { it.id }
                    val registered = result.tiles.mapNotNull { byId[it.id] }
                    _uiState.update { state -> state.copy(tiles = state.tiles + registered) }
                } catch (err: Exception) {
                    Log.e(LOG_TAG, "failed to add tiles", err)
                    _uiState.update { it.copy(error = EditorError.CoreFailed) }
                }
            }
            _uiState.update { it.copy(loading = null) }
            val state = _uiState.value
            if (session == sessionToken &&
                state.screen == EditorStage.Edit &&
                state.grid != null &&
                state.tiles.isNotEmpty()
            ) {
                startGeneration(rematch = true)
            }
        }
    }

    /** 構成画像を 1 枚削除する(編集中は残りのタイルで差分再マッチする) */
    fun removeTile(id: Long) {
        viewModelScope.launch {
            try {
                core.removeTile(id)
            } catch (err: Exception) {
                Log.e(LOG_TAG, "failed to remove tile", err)
            }
            _uiState.update { state -> state.copy(tiles = state.tiles.filterNot { it.id == id }) }
            val state = _uiState.value
            if (state.screen == EditorStage.Edit && state.grid != null) {
                if (state.tiles.isEmpty()) {
                    stopGeneration(notify = false)
                    mosaicBitmap = null
                    resultBitmap = null
                    _uiState.update {
                        it.copy(
                            preview = gridPreview,
                            previewRevision = it.previewRevision + 1,
                            progress = null,
                            resultReady = false,
                        )
                    }
                } else {
                    startGeneration(rematch = true)
                }
            }
        }
    }

    /** S1 から S2 編集画面へ進み、タイルがあれば生成を開始する */
    fun enterEdit() {
        val state = _uiState.value
        if (state.mainImage == null) {
            return
        }
        viewModelScope.launch {
            try {
                val config = core.getConfig()
                _uiState.update {
                    it.copy(
                        screen = EditorStage.Edit,
                        config = config,
                        blockSize = state.grid?.blockSize ?: DEFAULT_BLOCK_SIZE,
                        notice = null,
                    )
                }
                if (_uiState.value.tiles.isNotEmpty() && _uiState.value.grid != null) {
                    startGeneration(rematch = false)
                }
            } catch (err: Exception) {
                Log.e(LOG_TAG, "failed to read config", err)
                _uiState.update { it.copy(notice = EditorNotice.GenerationFailed) }
            }
        }
    }

    /** ブロックサイズのドラフト値を更新する(スライダー操作中) */
    fun setBlockSizeDraft(px: Int) {
        _uiState.update { it.copy(blockSize = px.coerceIn(MIN_BLOCK_SIZE, MAX_BLOCK_SIZE)) }
    }

    /** ブロックサイズの確定値を反映し、300ms 後に再生成する */
    fun commitBlockSize(px: Int) {
        val value = px.coerceIn(MIN_BLOCK_SIZE, MAX_BLOCK_SIZE)
        _uiState.update { it.copy(blockSize = value) }
        blockSizeJob?.cancel()
        blockSizeJob =
            viewModelScope.launch {
                delay(BLOCK_SIZE_DEBOUNCE_MS)
                val state = _uiState.value
                val grid = state.grid ?: return@launch
                if (grid.blockSize == value) {
                    return@launch
                }
                stopGeneration(notify = false)
                try {
                    val newGrid = core.setBlockSize(value)
                    val meanColors = core.getBlockMeanColors()
                    val preview =
                        withContext(Dispatchers.Default) {
                            meanColorsBitmap(newGrid, meanColors)
                        }
                    gridPreview = preview
                    resultBitmap = null
                    mosaicBitmap = null
                    _uiState.update {
                        it.copy(
                            grid = newGrid,
                            blockSize = newGrid.blockSize,
                            blockSizeAdjustedTo = null,
                            preview = preview,
                            previewRevision = it.previewRevision + 1,
                            progress = null,
                            resultReady = false,
                        )
                    }
                    if (_uiState.value.tiles.isNotEmpty()) {
                        startGeneration(rematch = false)
                    }
                } catch (err: Exception) {
                    Log.e(LOG_TAG, "failed to change block size", err)
                    _uiState.update { it.copy(notice = EditorNotice.GenerationFailed) }
                }
            }
    }

    /** メイン画像ブレンドのドラフト値を更新する */
    fun setMainBlend(value: Float) = updateConfigDraft { it.copy(mainBlend = value) }

    /** 色補正強度のドラフト値を更新する */
    fun setColorCorrect(value: Float) = updateConfigDraft { it.copy(colorCorrect = value) }

    /** 重複とみなす色の近さのドラフト値を更新する */
    fun setDuplicateDe(value: Float) = updateConfigDraft { it.copy(duplicateDe = value) }

    /** 設定の確定値をコアへ送り、タイルがあればフル再生成する */
    fun commitConfig() {
        val config = _uiState.value.config ?: return
        viewModelScope.launch {
            stopGeneration(notify = false)
            try {
                core.setConfig(config)
            } catch (err: Exception) {
                Log.e(LOG_TAG, "failed to update config", err)
                _uiState.update { it.copy(notice = EditorNotice.GenerationFailed) }
                return@launch
            }
            val state = _uiState.value
            if (state.grid != null && state.tiles.isNotEmpty()) {
                startGeneration(rematch = false)
            }
        }
    }

    /** 生成をバッチ境界でキャンセルする */
    fun cancelGeneration() {
        if (!_uiState.value.generating) {
            return
        }
        stopGeneration(notify = true)
    }

    /** 完成画像を PNG で保存する */
    fun save() {
        val bitmap = resultBitmap ?: return
        if (_uiState.value.saving) {
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(saving = true, notice = null) }
            try {
                exporter.savePng(bitmap)
                _uiState.update { it.copy(notice = EditorNotice.SaveSucceeded) }
            } catch (err: SecurityException) {
                Log.e(LOG_TAG, "storage permission denied", err)
                _uiState.update { it.copy(notice = EditorNotice.StoragePermissionDenied) }
            } catch (err: Exception) {
                Log.e(LOG_TAG, "failed to save image", err)
                _uiState.update { it.copy(notice = EditorNotice.SaveFailed) }
            } finally {
                _uiState.update { it.copy(saving = false) }
            }
        }
    }

    /** 共有シート用の Intent を生成する(UI 層が startActivity する) */
    fun share() {
        val bitmap = resultBitmap ?: return
        viewModelScope.launch {
            try {
                val intent =
                    withContext(Dispatchers.IO) {
                        exporter.createShareIntent(bitmap)
                    }
                _uiState.update { it.copy(shareIntent = intent) }
            } catch (err: Exception) {
                Log.e(LOG_TAG, "failed to create share intent", err)
                _uiState.update { it.copy(notice = EditorNotice.ShareFailed) }
            }
        }
    }

    /** 共有 Intent を UI 層が処理したことを通知する */
    fun shareHandled() {
        _uiState.update { it.copy(shareIntent = null) }
    }

    /** 進捗表示領域の開閉を切り替え、次回起動のために保存する */
    fun toggleProgress() {
        val expanded = !_uiState.value.progressExpanded
        progressPreferences.setExpanded(expanded)
        _uiState.update { it.copy(progressExpanded = expanded) }
    }

    /** API 26〜28 の保存権限が拒否された */
    fun storagePermissionDenied() {
        _uiState.update { it.copy(notice = EditorNotice.StoragePermissionDenied) }
    }

    /** 通知を閉じる */
    fun dismissNotice() {
        _uiState.update { it.copy(notice = null) }
    }

    /** メトリクス表示を閉じる */
    fun dismissMetrics() {
        _uiState.update { it.copy(metrics = null) }
    }

    /** S1 へ戻り、全状態をクリアする */
    fun reset() {
        sessionToken += 1
        val session = sessionToken
        stopGeneration(notify = false)
        blockSizeJob?.cancel()
        viewModelScope.launch {
            runCatching { core.clearMainImage() }
                .onFailure { Log.w(LOG_TAG, "failed to clear main image", it) }
            runCatching { core.clearTiles() }
                .onFailure { Log.w(LOG_TAG, "failed to clear tiles", it) }
            if (session != sessionToken) {
                return@launch
            }
            nextTileId = 0
            resultBitmap = null
            gridPreview = null
            mosaicBitmap = null
            _uiState.value =
                EditorUiState(
                    coreVersion = coreVersion,
                    progressExpanded = progressPreferences.isExpanded(),
                )
        }
    }

    override fun onCleared() {
        stopGeneration(notify = false)
        blockSizeJob?.cancel()
    }

    private fun updateConfigDraft(transform: (MosaicConfig) -> MosaicConfig) {
        _uiState.update { state ->
            val config = state.config ?: return@update state
            state.copy(config = transform(config))
        }
    }

    private fun stopGeneration(notify: Boolean) {
        generationToken += 1
        generationJob?.cancel()
        generationJob = null
        _uiState.update {
            it.copy(
                generating = false,
                notice = if (notify) EditorNotice.Canceled else it.notice,
            )
        }
    }

    @Suppress("CyclomaticComplexMethod", "LongMethod", "ReturnCount")
    private fun startGeneration(rematch: Boolean) {
        val state = _uiState.value
        val grid = state.grid ?: return
        if (state.tiles.isEmpty()) {
            return
        }
        stopGeneration(notify = false)
        val token = ++generationToken
        val base =
            if (rematch) {
                (state.preview ?: gridPreview)?.copy(Bitmap.Config.ARGB_8888, true)
            } else {
                gridPreview?.copy(Bitmap.Config.ARGB_8888, true)
            }
        if (base == null) {
            return
        }
        mosaicBitmap = base
        _uiState.update {
            it.copy(
                generating = true,
                resultReady = false,
                notice = null,
                preview = base,
                previewRevision = it.previewRevision + 1,
                progress = GenerationProgressUi("match", 0f, 0f, 0, grid.totalBlocks),
            )
        }
        generationJob =
            viewModelScope.launch {
                try {
                    val events = if (rematch) core.rematch() else core.run()
                    events.collect { event ->
                        if (token != generationToken) {
                            return@collect
                        }
                        when (event) {
                            is GenerationEvent.Progress -> onProgress(event.event)
                            is GenerationEvent.Batch -> onBatch(event.batch)
                            is GenerationEvent.Completed -> onCompleted(event.image, token)
                            GenerationEvent.Canceled -> {
                                _uiState.update {
                                    it.copy(generating = false, notice = EditorNotice.Canceled)
                                }
                            }
                            is GenerationEvent.Failed -> {
                                Log.e(LOG_TAG, "generation failed: ${event.message}")
                                _uiState.update {
                                    it.copy(
                                        generating = false,
                                        notice = EditorNotice.GenerationFailed,
                                    )
                                }
                            }
                        }
                    }
                } catch (err: CancellationException) {
                    throw err
                } catch (err: Exception) {
                    Log.e(LOG_TAG, "generation failed", err)
                    if (token == generationToken) {
                        _uiState.update {
                            it.copy(
                                generating = false,
                                notice = EditorNotice.GenerationFailed,
                            )
                        }
                    }
                } finally {
                    if (token == generationToken) {
                        _uiState.update { it.copy(generating = false) }
                    }
                }
            }
    }

    private fun onProgress(event: ProgressEvent) {
        _uiState.update {
            it.copy(
                progress =
                    GenerationProgressUi(
                        phaseCode = event.phaseCode,
                        phaseRatio = event.phaseRatio,
                        overallRatio = event.overallRatio,
                        assignedBlocks = event.assignedBlocks,
                        totalBlocks = event.totalBlocks,
                    ),
            )
        }
    }

    private suspend fun onBatch(batch: ResultBatch) {
        val base = mosaicBitmap ?: return
        val height = batch.rgba.size / (batch.width * BYTES_PER_PIXEL)
        if (height <= 0) {
            return
        }
        val piece =
            withContext(Dispatchers.Default) {
                rgbaToBitmap(batch.width, height, batch.rgba)
            }
        val top = batch.blockRowBegin * batch.blockSize
        val canvas = Canvas(base)
        canvas.drawBitmap(piece, 0f, top.toFloat(), null)
        _uiState.update {
            it.copy(
                preview = base,
                previewRevision = it.previewRevision + 1,
            )
        }
    }

    private suspend fun onCompleted(
        image: RgbaImage,
        token: Int,
    ) {
        val bitmap =
            withContext(Dispatchers.Default) {
                rgbaToBitmap(image.width, image.height, image.data)
            }
        if (token != generationToken) {
            return
        }
        resultBitmap = bitmap
        mosaicBitmap = null
        _uiState.update {
            val totalBlocks = it.grid?.totalBlocks ?: it.progress?.totalBlocks ?: 0
            val progress =
                (it.progress ?: GenerationProgressUi("done", 1f, 1f, totalBlocks, totalBlocks))
                    .copy(
                        phaseCode = "done",
                        phaseRatio = 1f,
                        overallRatio = 1f,
                        assignedBlocks = totalBlocks,
                        totalBlocks = totalBlocks,
                    )
            it.copy(
                preview = bitmap,
                previewRevision = it.previewRevision + 1,
                generating = false,
                resultReady = true,
                progress = progress,
            )
        }
        val rawMetrics =
            try {
                core.getMetrics()
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                Log.w(LOG_TAG, "failed to read metrics", err)
                null
            }
        val metrics = rawMetrics?.let(::parseMetrics)
        if (token != generationToken || metrics == null) {
            return
        }
        _uiState.update { it.copy(metrics = metrics) }
    }

    /** コアのメトリクス JSON から直近 run の表示用サマリを作る */
    private fun parseMetrics(raw: String): MetricsUi? {
        val root =
            runCatching { JSONObject(raw) }
                .onFailure { Log.w(LOG_TAG, "failed to parse metrics", it) }
                .getOrNull()
        val run =
            root
                ?.optJSONArray("runs")
                ?.let { runs ->
                    if (runs.length() > 0) {
                        runs.optJSONObject(runs.length() - 1)
                    } else {
                        null
                    }
                }
        val pretty =
            root
                ?.let { runCatching { it.toString(2) }.getOrDefault(raw) }
                ?: raw
        return if (run == null) {
            null
        } else {
            MetricsUi(summary = formatMetricsRun(run), rawJson = pretty)
        }
    }

    private fun formatMetricsRun(run: JSONObject): String {
        val phases = run.optJSONObject("phases")
        val p1 = phases?.optJSONObject("P1_MAIN_ANALYZE")?.optDouble("ms", 0.0) ?: 0.0
        val p2 = phases?.optJSONObject("P2_TILE_ANALYZE")
        val p3 = phases?.optJSONObject("P3_MATCH")
        val p4 = phases?.optJSONObject("P4_COMPOSE")
        val spans = run.optJSONObject("spans")
        val p3Max = spans?.optJSONObject("p3_match_batch")?.optDouble("max_ms", Double.NaN) ?: Double.NaN
        val p4Max = spans?.optJSONObject("p4_compose_batch")?.optDouble("max_ms", Double.NaN) ?: Double.NaN
        val tilesBytes = run.optJSONObject("memory")?.optLong("tiles_bytes", 0L) ?: 0L
        return buildString {
            append("[metrics #")
            append(run.optInt("run_id", 0))
            append("] trigger: ")
            append(run.optString("trigger", "-"))
            append('\n')
            append("P1 ")
            append(formatMetricMs(p1))
            append(" | P2 ")
            append(formatMetricMs(p2?.optDouble("ms", 0.0) ?: 0.0))
            append(" (")
            append(p2?.optInt("tiles", 0) ?: 0)
            append(") | P3 ")
            append(formatMetricMs(p3?.optDouble("ms", 0.0) ?: 0.0))
            append(" (")
            append(p3?.optInt("batches", 0) ?: 0)
            append(") | P4 ")
            append(formatMetricMs(p4?.optDouble("ms", 0.0) ?: 0.0))
            append(" (")
            append(p4?.optInt("batches", 0) ?: 0)
            append(')')
            append('\n')
            append("batch max: P3 ")
            append(formatMetricMax(p3Max))
            append(" / P4 ")
            append(formatMetricMax(p4Max))
            append(" | tiles ")
            append(formatMetricBytes(tilesBytes))
        }
    }

    private fun formatMetricMs(value: Double): String = "${value.roundToInt()}ms"

    private fun formatMetricMax(value: Double): String =
        if (value.isNaN()) {
            "-"
        } else {
            formatMetricMs(value)
        }

    private fun formatMetricBytes(bytes: Long): String =
        if (bytes >= MIB) {
            String.format(Locale.US, "%.1fMB", bytes.toDouble() / MIB)
        } else {
            "${Math.round(bytes.toDouble() / KIB)}KB"
        }

    /** ブロック平均色(RGB 3 バイト × ブロック数)をグリッド表示用 Bitmap へ描く */
    private fun meanColorsBitmap(
        grid: GridInfo,
        colors: ByteArray,
    ): Bitmap {
        val bitmap = Bitmap.createBitmap(grid.width, grid.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint()
        val required = grid.totalBlocks * RGB_CHANNELS
        if (colors.size < required) {
            return bitmap
        }
        var offset = 0
        for (row in 0 until grid.rows) {
            for (col in 0 until grid.cols) {
                val red = colors[offset++].toInt() and CHANNEL_MASK
                val green = colors[offset++].toInt() and CHANNEL_MASK
                val blue = colors[offset++].toInt() and CHANNEL_MASK
                paint.color = Color.rgb(red, green, blue)
                val left = col * grid.blockSize
                val top = row * grid.blockSize
                canvas.drawRect(
                    left.toFloat(),
                    top.toFloat(),
                    minOf(left + grid.blockSize, grid.width).toFloat(),
                    minOf(top + grid.blockSize, grid.height).toFloat(),
                    paint,
                )
            }
        }
        return bitmap
    }

    companion object {
        private const val LOG_TAG = "EditorViewModel"
        private const val BLOCK_SIZE_DEBOUNCE_MS = 300L
        private const val FEATURE_SIZE = 32
        private const val BYTES_PER_PIXEL = 4
        private const val RGB_CHANNELS = 3
        private const val CHANNEL_MASK = 0xff
        private const val KIB = 1024.0
        private const val MIB = 1024.0 * 1024.0

        /** アプリの Context から実装(端末内デコーダ・MediaStore)を組み立てる */
        fun factory(
            context: Context,
            coreVersion: String,
            core: CoreEngine,
        ): ViewModelProvider.Factory =
            viewModelFactory {
                initializer {
                    val appContext = context.applicationContext
                    EditorViewModel(
                        coreVersion = coreVersion,
                        core = core,
                        imageLoader = AndroidImageLoader(appContext),
                        exporter = ImageExporter(appContext),
                        progressPreferences = SharedPreferencesProgressPreferences(appContext),
                    )
                }
            }
    }
}
