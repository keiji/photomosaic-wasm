package dev.keiji.photomasaic.core

/**
 * コア起動検査の結果(A0)。
 * サンドボックス対応・WebAssembly 対応・コアバージョンの 3 点を画面へ伝える。
 */
sealed interface CoreStartupResult {
    /** サンドボックスと WebAssembly が利用でき、コアのバージョンを取得できた */
    data class Ready(
        val coreVersion: String,
    ) : CoreStartupResult

    /** この端末では JavaScript エンジン(サンドボックス)が利用できない */
    data object SandboxUnsupported : CoreStartupResult

    /** サンドボックスは利用できるが WebAssembly が利用できない */
    data object WebAssemblyUnavailable : CoreStartupResult

    /** 起動処理が失敗した(原因メッセージ付き) */
    data class Failed(
        val message: String,
    ) : CoreStartupResult
}

/**
 * コア実行基盤(A0 では起動検査とバージョン取得のみ)。
 * 実装は AndroidX JavaScriptEngine(別プロセスのサンドボックス)を使う。
 */
interface CoreEngine : AutoCloseable {
    /** 起動検査を実行する。失敗時の再試行にも呼べる */
    suspend fun start(): CoreStartupResult
}
