package dev.keiji.photomasaic.io

import android.graphics.Bitmap

private const val CHANNEL_MASK = 0xff
private const val ALPHA_SHIFT = 24
private const val RED_SHIFT = 16
private const val GREEN_SHIFT = 8
private const val BYTES_PER_PIXEL = 4

/** Bitmap をコア入力の正規形 RGBA(行優先、非プリマルチプライ)へ変換する */
fun bitmapToRgba(bitmap: Bitmap): ByteArray {
    val width = bitmap.width
    val height = bitmap.height
    val pixels = IntArray(width * height)
    bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
    return argbToRgba(pixels)
}

/** ARGB の IntArray を RGBA バイト列へ変換する(タイル特徴量サムネイル用) */
fun argbToRgba(pixels: IntArray): ByteArray {
    val output = ByteArray(pixels.size * BYTES_PER_PIXEL)
    var offset = 0
    for (pixel in pixels) {
        output[offset++] = ((pixel ushr RED_SHIFT) and CHANNEL_MASK).toByte()
        output[offset++] = ((pixel ushr GREEN_SHIFT) and CHANNEL_MASK).toByte()
        output[offset++] = (pixel and CHANNEL_MASK).toByte()
        output[offset++] = ((pixel ushr ALPHA_SHIFT) and CHANNEL_MASK).toByte()
    }
    return output
}

/** コア出力の RGBA バイト列を Bitmap へ変換する */
fun rgbaToBitmap(
    width: Int,
    height: Int,
    rgba: ByteArray,
): Bitmap {
    require(width > 0 && height > 0) { "image size must be positive" }
    require(rgba.size >= width * height * BYTES_PER_PIXEL) { "rgba buffer is too small" }
    val pixels = IntArray(width * height)
    var offset = 0
    for (index in pixels.indices) {
        val red = rgba[offset++].toInt() and CHANNEL_MASK
        val green = rgba[offset++].toInt() and CHANNEL_MASK
        val blue = rgba[offset++].toInt() and CHANNEL_MASK
        val alpha = rgba[offset++].toInt() and CHANNEL_MASK
        pixels[index] = (alpha shl ALPHA_SHIFT) or (red shl RED_SHIFT) or (green shl GREEN_SHIFT) or blue
    }
    return Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
}
