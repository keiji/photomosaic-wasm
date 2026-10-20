package dev.keiji.photomasaic.core

import org.json.JSONObject

/** グリッド情報(詳細設計書 3 章 GridInfo) */
data class GridInfo(
    val width: Int,
    val height: Int,
    val blockSize: Int,
    val cols: Int,
    val rows: Int,
    val totalBlocks: Int,
)

/** 進捗イベント(詳細設計書 3 章 ProgressEvent) */
data class ProgressEvent(
    val phaseCode: String,
    val phaseRatio: Float,
    val overallRatio: Float,
    val assignedBlocks: Int,
    val totalBlocks: Int,
)

/** 部分結果(詳細設計書 3 章 ResultBatch) */
data class ResultBatch(
    val blockRowBegin: Int,
    val blockRowEnd: Int,
    val blockSize: Int,
    val width: Int,
    val rgba: ByteArray,
)

/** コア入出力の正規形 RGBA 画像(行優先、非プリマルチプライ、sRGB) */
data class RgbaImage(
    val width: Int,
    val height: Int,
    val data: ByteArray,
)

/** タイル情報(詳細設計書 3 章 TileFeature) */
data class TileInfo(
    val id: Long,
    val thumbWidth: Int,
    val thumbHeight: Int,
    val meanLab: FloatArray,
    val detail: Float,
    val usage: Int,
)

/** 一括登録するタイル 1 枚分の入力(特徴量用 32×32 と合成用サムネイル) */
data class TileInput(
    val id: Long,
    val feature: RgbaImage,
    val compose: RgbaImage,
)

/** タイル一括登録の結果。成功分と、失敗したタイルのエラーを返す */
data class TileBatchResult(
    val tiles: List<TileInfo>,
    val errors: List<String>,
)

/** マッチング・合成の設定(詳細設計書 5 章。キー名はコアの JSON と一致) */
data class MosaicConfig(
    val wC: Float = 1.0f,
    val wD: Float = 0.25f,
    val usagePenalty: Float = 0.35f,
    val neighborPenalty: Float = 0.5f,
    val neighborDe: Float = 8.0f,
    val identicalDe: Float = 2.0f,
    val improveMargin: Float = 1.0f,
    val duplicateDe: Float = 2.0f,
    val duplicateDetail: Float = 4.0f,
    val usageCap: Int = 1,
    val colorCorrect: Float = 0.85f,
    val mainBlend: Float = 0.2f,
    val rowBatch: Int = 8,
) {
    fun toJson(): JSONObject =
        JSONObject()
            .put("w_c", wC.toDouble())
            .put("w_d", wD.toDouble())
            .put("usage_penalty", usagePenalty.toDouble())
            .put("neighbor_penalty", neighborPenalty.toDouble())
            .put("neighbor_de", neighborDe.toDouble())
            .put("identical_de", identicalDe.toDouble())
            .put("improve_margin", improveMargin.toDouble())
            .put("duplicate_de", duplicateDe.toDouble())
            .put("duplicate_detail", duplicateDetail.toDouble())
            .put("usage_cap", usageCap)
            .put("color_correct", colorCorrect.toDouble())
            .put("main_blend", mainBlend.toDouble())
            .put("row_batch", rowBatch)

    companion object {
        fun default(): MosaicConfig = MosaicConfig()

        fun fromJson(json: JSONObject): MosaicConfig =
            MosaicConfig(
                wC = json.getDouble("w_c").toFloat(),
                wD = json.getDouble("w_d").toFloat(),
                usagePenalty = json.getDouble("usage_penalty").toFloat(),
                neighborPenalty = json.getDouble("neighbor_penalty").toFloat(),
                neighborDe = json.getDouble("neighbor_de").toFloat(),
                identicalDe = json.getDouble("identical_de").toFloat(),
                improveMargin = json.getDouble("improve_margin").toFloat(),
                duplicateDe = json.getDouble("duplicate_de").toFloat(),
                duplicateDetail = json.getDouble("duplicate_detail").toFloat(),
                usageCap = json.getInt("usage_cap"),
                colorCorrect = json.getDouble("color_correct").toFloat(),
                mainBlend = json.getDouble("main_blend").toFloat(),
                rowBatch = json.getInt("row_batch"),
            )
    }
}

/** 生成・差分再マッチのストリームイベント(A2) */
sealed interface GenerationEvent {
    data class Progress(
        val event: ProgressEvent,
    ) : GenerationEvent

    data class Batch(
        val batch: ResultBatch,
    ) : GenerationEvent

    data class Completed(
        val image: RgbaImage,
    ) : GenerationEvent

    data object Canceled : GenerationEvent

    data class Failed(
        val message: String,
    ) : GenerationEvent
}

/** コアの応答・実行エラー */
class CoreException(
    message: String,
) : Exception(message)

/** GridInfo の JSON 変換(ホスト JS の応答形式) */
internal fun JSONObject.toGridInfo(): GridInfo =
    GridInfo(
        width = getInt("width"),
        height = getInt("height"),
        blockSize = getInt("blockSize"),
        cols = getInt("cols"),
        rows = getInt("rows"),
        totalBlocks = getInt("totalBlocks"),
    )

/** TileInfo の JSON 変換(ホスト JS の応答形式) */
internal fun JSONObject.toTileInfo(): TileInfo {
    val lab = getJSONArray("meanLab")
    return TileInfo(
        id = getLong("id"),
        thumbWidth = getInt("thumbWidth"),
        thumbHeight = getInt("thumbHeight"),
        meanLab =
            floatArrayOf(
                lab.getDouble(0).toFloat(),
                lab.getDouble(1).toFloat(),
                lab.getDouble(2).toFloat(),
            ),
        detail = getDouble("detail").toFloat(),
        usage = getInt("usage"),
    )
}
