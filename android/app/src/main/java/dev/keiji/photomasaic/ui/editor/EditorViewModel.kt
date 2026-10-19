package dev.keiji.photomasaic.ui.editor

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.keiji.photomasaic.io.AndroidImageLoader
import dev.keiji.photomasaic.io.ImageLoader
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

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

/** 画像読み込みの失敗種別(UI 層が文言へ変換する) */
enum class EditorError {
    DecodeFailed,
}

/** S1 開始画面の状態(A1) */
data class EditorUiState(
    val coreVersion: String,
    val mainImage: MainImageUi? = null,
    val tiles: List<TileUi> = emptyList(),
    val loading: Loading? = null,
    val error: EditorError? = null,
) {
    /** タイル読み込みの進捗(処理済み / 受け付け数) */
    data class Loading(
        val processed: Int,
        val total: Int,
    )
}

/**
 * S1 開始画面の状態を保持する ViewModel(A1)。
 * 画像の選択・デコード・一覧管理を担い、UI 層は状態の表示のみを行う。
 */
@Suppress("TooGenericExceptionCaught")
class EditorViewModel(
    coreVersion: String,
    private val imageLoader: ImageLoader,
) : ViewModel() {
    private val _uiState = MutableStateFlow(EditorUiState(coreVersion))
    val uiState: StateFlow<EditorUiState> = _uiState.asStateFlow()
    private var nextTileId = 0L

    /** メイン画像を選択・変更する */
    fun setMainImage(uri: Uri) {
        viewModelScope.launch {
            _uiState.update { it.copy(error = null) }
            try {
                val loaded = imageLoader.loadMainImage(uri)
                _uiState.update {
                    it.copy(
                        mainImage =
                            MainImageUi(
                                bitmap = loaded.bitmap,
                                width = loaded.width,
                                height = loaded.height,
                                scaled = loaded.scaled,
                            ),
                    )
                }
            } catch (err: Exception) {
                Log.e(LOG_TAG, "failed to load main image", err)
                _uiState.update { it.copy(error = EditorError.DecodeFailed) }
            }
        }
    }

    /** 構成画像をまとめて追加する(1 枚ずつデコードして一覧へ足す) */
    fun addTiles(uris: List<Uri>) {
        if (uris.isEmpty() || _uiState.value.loading != null) {
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(error = null, loading = EditorUiState.Loading(0, uris.size)) }
            var processed = 0
            for (uri in uris) {
                try {
                    val loaded = imageLoader.loadTile(uri)
                    nextTileId += 1
                    val tile = TileUi(id = nextTileId, bitmap = loaded.compose)
                    _uiState.update { state -> state.copy(tiles = state.tiles + tile) }
                } catch (err: Exception) {
                    Log.e(LOG_TAG, "failed to load tile", err)
                    _uiState.update { it.copy(error = EditorError.DecodeFailed) }
                }
                processed += 1
                _uiState.update { it.copy(loading = EditorUiState.Loading(processed, uris.size)) }
            }
            _uiState.update { it.copy(loading = null) }
        }
    }

    /** 構成画像を 1 枚削除する */
    fun removeTile(id: Long) {
        _uiState.update { state -> state.copy(tiles = state.tiles.filterNot { it.id == id }) }
    }

    companion object {
        private const val LOG_TAG = "EditorViewModel"

        /** アプリの Context から実装(端末内デコーダ)を組み立てる */
        fun factory(
            context: Context,
            coreVersion: String,
        ): ViewModelProvider.Factory =
            viewModelFactory {
                initializer {
                    EditorViewModel(coreVersion, AndroidImageLoader(context.applicationContext))
                }
            }
    }
}
