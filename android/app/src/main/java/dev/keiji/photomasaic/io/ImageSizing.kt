package dev.keiji.photomasaic.io

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** メイン画像の長辺上限 px(詳細設計書 5 章 main_max_edge) */
const val MAIN_MAX_EDGE = 4096

/** ブロックサイズの下限 px(基本設計書 2.2) */
const val MIN_BLOCK_SIZE = 8

/** ブロックサイズの上限 px(基本設計書 2.2) */
const val MAX_BLOCK_SIZE = 128

/** 特徴量算出用サムネイルの 1 辺 px(詳細設計書 5 章 feature_thumb、32×32 固定) */
const val TILE_FEATURE_THUMB = 32

/** 合成用サムネイルの長辺上限 px(詳細設計書 5 章 compose_thumb_max) */
const val TILE_COMPOSE_THUMB_MAX = 64

private const val CHANNEL_MAX = 255
private const val CHANNEL_MASK = 0xff
private const val ALPHA_SHIFT = 24
private const val RED_SHIFT = 16
private const val GREEN_SHIFT = 8

/** 正規化後の寸法(縮小が発生したかを UI の案内に使う) */
data class NormalizedSize(
    val width: Int,
    val height: Int,
    val scaled: Boolean,
)

/**
 * 正規化後のサイズを計算する(純関数)。
 * 長辺が maxEdge を超える場合は等比で縮小し、超えない場合は元サイズを返す。
 * Web の normalizeSize と同じ丸め方(各辺を独立に四捨五入)に揃える。
 */
fun normalizeSize(
    width: Int,
    height: Int,
    maxEdge: Int = MAIN_MAX_EDGE,
): NormalizedSize {
    require(width > 0 && height > 0) { "image size must be positive" }
    require(maxEdge > 0) { "max edge must be positive" }
    val maxSide = max(width, height)
    if (maxSide <= maxEdge) {
        return NormalizedSize(width, height, scaled = false)
    }
    val scale = maxEdge.toDouble() / maxSide
    return NormalizedSize(
        width = max(1, (width * scale).roundToInt()),
        height = max(1, (height * scale).roundToInt()),
        scaled = true,
    )
}

/**
 * 画像が小さく 1 ブロックしか作れない場合の自動調整後ブロックサイズを返す(純関数)。
 * 詳細設計書 5 章: ブロック数が 1(画像 < block_size)のとき、短辺へ自動調整する。
 * 調整不要なら null。UI の下限・上限に収める。
 */
fun autoBlockSizeForSmallImage(
    width: Int,
    height: Int,
    blockSize: Int,
): Int? {
    require(width > 0 && height > 0) { "image size must be positive" }
    require(blockSize > 0) { "block size must be positive" }
    val cols = (width + blockSize - 1) / blockSize
    val rows = (height + blockSize - 1) / blockSize
    val shortSide = min(width, height)
    val needsAdjustment = cols == 1 && rows == 1 && shortSide < blockSize
    return if (needsAdjustment) {
        shortSide.coerceIn(MIN_BLOCK_SIZE, MAX_BLOCK_SIZE).takeIf { it != blockSize }
    } else {
        null
    }
}

/**
 * 合成用サムネイルの寸法を計算する(純関数)。
 * 長辺が maxEdge を超える場合はアスペクト維持のまま縮小する。
 */
fun composeThumbSize(
    width: Int,
    height: Int,
    maxEdge: Int = TILE_COMPOSE_THUMB_MAX,
): NormalizedSize {
    require(width > 0 && height > 0) { "image size must be positive" }
    require(maxEdge > 0) { "max edge must be positive" }
    val maxSide = max(width, height)
    if (maxSide <= maxEdge) {
        return NormalizedSize(width, height, scaled = false)
    }
    val scale = maxEdge.toDouble() / maxSide
    return NormalizedSize(
        width = max(1, (width * scale).roundToInt()),
        height = max(1, (height * scale).roundToInt()),
        scaled = true,
    )
}

/**
 * ボックスフィルタ(面積平均)による縮小(純関数)。
 *
 * 出力 1 ピクセルごとに、対応する入力矩形領域の加重平均を取る。
 * 端数ピクセルは被覆面積を重みに加味する。入力は ARGB の IntArray。
 * Web の boxResize と同じく、アスペクト比に関係なく指定寸法へ縮小する。
 */
@Suppress("NestedBlockDepth")
fun boxResize(
    source: IntArray,
    sourceWidth: Int,
    sourceHeight: Int,
    targetWidth: Int,
    targetHeight: Int,
): IntArray {
    require(targetWidth > 0 && targetHeight > 0) { "target size must be positive" }
    require(sourceWidth > 0 && sourceHeight > 0) { "source size must be positive" }
    require(source.size >= sourceWidth * sourceHeight) { "source pixel array is too small" }

    val output = IntArray(targetWidth * targetHeight)
    val scaleX = sourceWidth.toDouble() / targetWidth
    val scaleY = sourceHeight.toDouble() / targetHeight

    for (ty in 0 until targetHeight) {
        val sy0 = ty * scaleY
        val sy1 = (ty + 1) * scaleY
        val yStart = floor(sy0).toInt()
        val yEnd = min(ceil(sy1).toInt(), sourceHeight)
        for (tx in 0 until targetWidth) {
            val sx0 = tx * scaleX
            val sx1 = (tx + 1) * scaleX
            val xStart = floor(sx0).toInt()
            val xEnd = min(ceil(sx1).toInt(), sourceWidth)

            var sumA = 0.0
            var sumR = 0.0
            var sumG = 0.0
            var sumB = 0.0
            var weightSum = 0.0

            for (sy in yStart until yEnd) {
                val wy = min(sy + 1.0, sy1) - max(sy.toDouble(), sy0)
                if (wy <= 0.0) continue
                val rowOffset = sy * sourceWidth
                for (sx in xStart until xEnd) {
                    val wx = min(sx + 1.0, sx1) - max(sx.toDouble(), sx0)
                    if (wx <= 0.0) continue
                    val weight = wx * wy
                    val pixel = source[rowOffset + sx]
                    sumA += ((pixel ushr ALPHA_SHIFT) and CHANNEL_MASK) * weight
                    sumR += ((pixel ushr RED_SHIFT) and CHANNEL_MASK) * weight
                    sumG += ((pixel ushr GREEN_SHIFT) and CHANNEL_MASK) * weight
                    sumB += (pixel and CHANNEL_MASK) * weight
                    weightSum += weight
                }
            }

            val outIndex = ty * targetWidth + tx
            output[outIndex] =
                if (weightSum > 0.0) {
                    packArgb(
                        channel(sumA, weightSum),
                        channel(sumR, weightSum),
                        channel(sumG, weightSum),
                        channel(sumB, weightSum),
                    )
                } else {
                    // 拡大時のフォールバック: 最近傍
                    val srcX = min(sourceWidth - 1, floor(sx0).toInt())
                    val srcY = min(sourceHeight - 1, floor(sy0).toInt())
                    source[srcY * sourceWidth + srcX]
                }
        }
    }
    return output
}

private fun channel(
    sum: Double,
    weightSum: Double,
): Int = (sum / weightSum).roundToInt().coerceIn(0, CHANNEL_MAX)

private fun packArgb(
    a: Int,
    r: Int,
    g: Int,
    b: Int,
): Int = (a shl ALPHA_SHIFT) or (r shl RED_SHIFT) or (g shl GREEN_SHIFT) or b
