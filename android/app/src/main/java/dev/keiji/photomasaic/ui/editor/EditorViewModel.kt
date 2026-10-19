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
import dev.keiji.photomasaic.io.AndroidImageLoader
import dev.keiji.photomasaic.io.ImageExporter
import dev.keiji.photomasaic.io.ImageLoadException
import dev.keiji.photomasaic.io.ImageLoader
import dev.keiji.photomasaic.io.argbToRgba
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
    val generating: Boolean = false,
    val resultReady: Boolean = false,
    val saving: Boolean = false,
    val config: MosaicConfig? = null,
    val blockSize: Int = DEFAULT_BLOCK_SIZE,
    val progressExpanded: Boolean = true,
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
    val onTilesSelected: (List<Uri>) -> Unit = {},
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
)

/**
 * S1 開始画面・S2 編集画面の状態を保持する ViewModel(A1/A2)。
 * 画像の選択・デコード・一覧管理に加え、コアの生成フロー(進捗・部分結果・
 * 完成画像)を購読し、プレビュー用 Bitmap と進捗を状態へ反映する。
 */
@Suppress("TooManyFunctions", "TooGenericExceptionCaught")
class EditorViewModel(
    private val coreVersion: String,
    private val core: CoreEngine,
    private val imageLoader: ImageLoader,
    private val exporter: ImageExporter,
) : ViewModel() {
    private val _uiState = MutableStateFlow(EditorUiState(coreVersion))
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
                val grid =
                    core.setMainImage(
                        RgbaImage(loaded.width, loaded.height, rgba),
                    )
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

    /** 構成画像をまとめて追加する(1 枚ずつデコード・解析して一覧へ足す) */
    @Suppress("ComplexCondition")
    fun addTiles(uris: List<Uri>) {
        if (uris.isEmpty() || _uiState.value.loading != null) {
            return
        }
        val session = sessionToken
        viewModelScope.launch {
            _uiState.update { it.copy(error = null, loading = EditorUiState.Loading(0, uris.size)) }
            var processed = 0
            for (uri in uris) {
                try {
                    val loaded = imageLoader.loadTile(uri)
                    val feature = argbToRgba(loaded.feature)
                    val compose = bitmapToRgba(loaded.compose)
                    nextTileId += 1
                    val info =
                        core.addTile(
                            id = nextTileId,
                            feature = RgbaImage(FEATURE_SIZE, FEATURE_SIZE, feature),
                            compose =
                                RgbaImage(
                                    loaded.compose.width,
                                    loaded.compose.height,
                                    compose,
                                ),
                        )
                    if (session != sessionToken) {
                        return@launch
                    }
                    val tile = TileUi(id = info.id, bitmap = loaded.compose)
                    _uiState.update { state -> state.copy(tiles = state.tiles + tile) }
                } catch (err: ImageLoadException) {
                    Log.e(LOG_TAG, "failed to load tile", err)
                    _uiState.update { it.copy(error = EditorError.DecodeFailed) }
                } catch (err: Exception) {
                    Log.e(LOG_TAG, "failed to add tile", err)
                    _uiState.update { it.copy(error = EditorError.CoreFailed) }
                }
                processed += 1
                _uiState.update { it.copy(loading = EditorUiState.Loading(processed, uris.size)) }
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

    /** 進捗表示領域の開閉を切り替える */
    fun toggleProgress() {
        _uiState.update { it.copy(progressExpanded = !it.progressExpanded) }
    }

    /** API 26〜28 の保存権限が拒否された */
    fun storagePermissionDenied() {
        _uiState.update { it.copy(notice = EditorNotice.StoragePermissionDenied) }
    }

    /** 通知を閉じる */
    fun dismissNotice() {
        _uiState.update { it.copy(notice = null) }
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
            _uiState.value = EditorUiState(coreVersion)
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
                            is GenerationEvent.Completed -> onCompleted(event.image)
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

    private suspend fun onCompleted(image: RgbaImage) {
        val bitmap =
            withContext(Dispatchers.Default) {
                rgbaToBitmap(image.width, image.height, image.data)
            }
        resultBitmap = bitmap
        mosaicBitmap = null
        _uiState.update {
            it.copy(
                preview = bitmap,
                previewRevision = it.previewRevision + 1,
                generating = false,
                resultReady = true,
                progress =
                    it.progress?.copy(
                        phaseCode = "compose",
                        phaseRatio = 1f,
                        overallRatio = 1f,
                        assignedBlocks = it.grid?.totalBlocks ?: it.progress.assignedBlocks,
                        totalBlocks = it.grid?.totalBlocks ?: it.progress.totalBlocks,
                    ),
            )
        }
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
        private const val MIN_BLOCK_SIZE = 8
        private const val MAX_BLOCK_SIZE = 128
        private const val BLOCK_SIZE_DEBOUNCE_MS = 300L
        private const val FEATURE_SIZE = 32
        private const val BYTES_PER_PIXEL = 4
        private const val RGB_CHANNELS = 3
        private const val CHANNEL_MASK = 0xff

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
                    )
                }
            }
    }
}
