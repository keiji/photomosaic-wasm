package dev.keiji.photomasaic.core

import kotlinx.coroutines.flow.Flow

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
 * コア実行基盤(論理 API の Kotlin 側インターフェース)。
 * 実装は AndroidX JavaScriptEngine(別プロセスのサンドボックス)を使い、
 * ホスト JS と MessagePort で双方向通信する。
 */
@Suppress("TooManyFunctions") // 論理 API の関数群をそのまま写している
interface CoreEngine : AutoCloseable {
    /** 起動検査を実行する。失敗時の再試行にも呼べる */
    suspend fun start(): CoreStartupResult

    /** メイン画像を設定し、グリッド・ブロック特徴量を計算する(P1) */
    suspend fun setMainImage(image: RgbaImage): GridInfo

    /** ブロックサイズを変更してグリッドを再計算する(P1 再実行) */
    suspend fun setBlockSize(px: Int): GridInfo

    /** コア算出のブロック平均色(RGB 3 バイト × ブロック数)を取得する */
    suspend fun getBlockMeanColors(): ByteArray

    /** タイル 1 枚を解析してプールへ登録する(P2) */
    suspend fun addTile(
        id: Long,
        feature: RgbaImage,
        compose: RgbaImage,
    ): TileInfo

    /** プールからタイルを削除する */
    suspend fun removeTile(id: Long)

    /** タイルプールを空にする */
    suspend fun clearTiles()

    /** メイン画像の状態を破棄する */
    suspend fun clearMainImage()

    /** 全ブロックを再マッチして生成する(P3+P4)。進捗・部分結果を流す */
    fun run(): Flow<GenerationEvent>

    /** 差分再マッチ(M6)。未確定ブロックのマッチ・差し替え評価を行う */
    fun rematch(): Flow<GenerationEvent>

    /** 実行中の生成をバッチ境界でキャンセルする */
    suspend fun cancel()

    /** 現在の設定パラメータを取得する */
    suspend fun getConfig(): MosaicConfig

    /** 設定パラメータを上書きする(範囲外はコアがエラーを返す) */
    suspend fun setConfig(config: MosaicConfig)
}
