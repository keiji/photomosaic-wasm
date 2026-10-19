package dev.keiji.photomasaic.ui.startup

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.keiji.photomasaic.core.CoreEngine
import dev.keiji.photomasaic.core.CoreStartupResult
import dev.keiji.photomasaic.core.JsCoreEngine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** A0 起動検査の画面状態(UI 層は状態の表示のみを担う)。 */
sealed interface StartupUiState {
    /** 起動検査中 */
    data object Checking : StartupUiState

    /** サンドボックス・WebAssembly が利用可能で、コアバージョンを取得済み */
    data class Ready(
        val coreVersion: String,
    ) : StartupUiState

    /** この端末では JavaScript エンジン(サンドボックス)が利用できない */
    data object SandboxUnsupported : StartupUiState

    /** この端末では WebAssembly が利用できない */
    data object WebAssemblyUnavailable : StartupUiState

    /** 起動処理が失敗した(原因メッセージ付き) */
    data class Failed(
        val message: String,
    ) : StartupUiState
}

/** 起動検査の状態を保持する ViewModel(A0)。 */
class StartupViewModel(
    val engine: CoreEngine,
) : ViewModel() {
    private val _uiState = MutableStateFlow<StartupUiState>(StartupUiState.Checking)
    val uiState: StateFlow<StartupUiState> = _uiState.asStateFlow()

    init {
        check()
    }

    /** 起動検査を実行する(失敗時の再試行にも使う) */
    fun check() {
        _uiState.value = StartupUiState.Checking
        viewModelScope.launch {
            _uiState.value =
                when (val result = engine.start()) {
                    is CoreStartupResult.Ready -> StartupUiState.Ready(result.coreVersion)
                    CoreStartupResult.SandboxUnsupported -> StartupUiState.SandboxUnsupported
                    CoreStartupResult.WebAssemblyUnavailable -> StartupUiState.WebAssemblyUnavailable
                    is CoreStartupResult.Failed -> StartupUiState.Failed(result.message)
                }
        }
    }

    override fun onCleared() {
        engine.close()
    }

    companion object {
        /** アプリの Context から実装(AndroidX JavaScriptEngine)を組み立てる */
        fun factory(context: Context): ViewModelProvider.Factory =
            viewModelFactory {
                initializer { StartupViewModel(JsCoreEngine(context.applicationContext)) }
            }
    }
}
