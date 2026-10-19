package dev.keiji.photomasaic.io

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.exifinterface.media.ExifInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException

/** 正規化済みのメイン画像(白背景で不透明化済み) */
data class LoadedMainImage(
    val bitmap: Bitmap,
    val width: Int,
    val height: Int,
    val scaled: Boolean,
)

/** タイル 1 枚分の 2 種サムネイル(コア addTile の入力) */
data class LoadedTile(
    /** 特徴量算出用サムネイル(32×32、ARGB) */
    val feature: IntArray,
    /** 合成用サムネイル(長辺 64 上限、白背景で不透明化済み) */
    val compose: Bitmap,
)

/** 画像デコードの失敗(UI 層は再選択を案内する) */
class ImageLoadException(
    message: String,
    cause: Throwable? = null,
) : IOException(message, cause)

/** 画像 I/O の抽象(ViewModel のテストで差し替えられるようにする) */
interface ImageLoader {
    suspend fun loadMainImage(uri: Uri): LoadedMainImage

    suspend fun loadTile(uri: Uri): LoadedTile
}

/**
 * 端末内で画像をデコード・正規化する実装(A1)。
 *
 * - API 28 以降は ImageDecoder(EXIF 回転を自動反映、縮小も同時に指定)
 * - API 26〜27 は BitmapFactory + ExifInterface で回転を反映してから縮小
 * - アルファ付き画像は白背景へ合成して不透明化する(詳細設計書 6 章)
 * - メイン画像は長辺 4096px 以下、タイルは合成用 64px 以下へ縮小する
 */
class AndroidImageLoader(
    private val context: Context,
) : ImageLoader {
    override suspend fun loadMainImage(uri: Uri): LoadedMainImage =
        withContext(Dispatchers.IO) {
            val decoded = decodeScaled(uri, MAIN_MAX_EDGE)
            val flattened = flattenOnWhite(decoded.bitmap, decoded.width, decoded.height)
            if (flattened !== decoded.bitmap) {
                decoded.bitmap.recycle()
            }
            LoadedMainImage(flattened, decoded.width, decoded.height, decoded.scaled)
        }

    override suspend fun loadTile(uri: Uri): LoadedTile =
        withContext(Dispatchers.IO) {
            val decoded = decodeScaled(uri, TILE_COMPOSE_THUMB_MAX)
            val flattened = flattenOnWhite(decoded.bitmap, decoded.width, decoded.height)
            if (flattened !== decoded.bitmap) {
                decoded.bitmap.recycle()
            }
            LoadedTile(featureThumb(flattened), flattened)
        }

    private fun featureThumb(source: Bitmap): IntArray {
        val pixels = IntArray(source.width * source.height)
        source.getPixels(pixels, 0, source.width, 0, 0, source.width, source.height)
        return boxResize(pixels, source.width, source.height, TILE_FEATURE_THUMB, TILE_FEATURE_THUMB)
    }

    private fun decodeScaled(
        uri: Uri,
        maxEdge: Int,
    ): DecodedImage =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            decodeWithImageDecoder(uri, maxEdge)
        } else {
            decodeWithBitmapFactory(uri, maxEdge)
        }

    @RequiresApi(Build.VERSION_CODES.P)
    @Suppress("TooGenericExceptionCaught")
    private fun decodeWithImageDecoder(
        uri: Uri,
        maxEdge: Int,
    ): DecodedImage {
        var width = 0
        var height = 0
        var scaled = false
        try {
            val source = ImageDecoder.createSource(context.contentResolver, uri)
            val bitmap =
                ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                    val target = normalizeSize(info.size.width, info.size.height, maxEdge)
                    width = target.width
                    height = target.height
                    scaled = target.scaled
                    decoder.setTargetSize(target.width, target.height)
                    decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
                    decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE)
                }
            return DecodedImage(bitmap, width, height, scaled)
        } catch (err: Exception) {
            throw ImageLoadException("failed to decode image: $uri", err)
        }
    }

    @Suppress("DEPRECATION", "TooGenericExceptionCaught")
    private fun decodeWithBitmapFactory(
        uri: Uri,
        maxEdge: Int,
    ): DecodedImage {
        val size = readOrientedSize(uri)
        val target = normalizeSize(size.width, size.height, maxEdge)
        val options =
            BitmapFactory.Options().apply {
                inPreferredConfig = Bitmap.Config.ARGB_8888
                inSampleSize = calculateInSampleSize(size.width, size.height, target.width, target.height)
            }
        try {
            val decoded =
                context.contentResolver.openInputStream(uri)?.use {
                    BitmapFactory.decodeStream(it, null, options)
                } ?: throw ImageLoadException("failed to open image: $uri")
            val oriented = applyOrientation(decoded, size.orientation)
            val scaledBitmap =
                if (oriented.width != target.width || oriented.height != target.height) {
                    Bitmap.createScaledBitmap(oriented, target.width, target.height, true)
                } else {
                    oriented
                }
            if (scaledBitmap !== oriented) {
                oriented.recycle()
            }
            return DecodedImage(scaledBitmap, target.width, target.height, target.scaled)
        } catch (err: Exception) {
            throw ImageLoadException("failed to decode image: $uri", err)
        }
    }

    @Suppress("DEPRECATION", "TooGenericExceptionCaught")
    private fun readOrientedSize(uri: Uri): OrientedSize {
        val options =
            BitmapFactory.Options().apply {
                inJustDecodeBounds = true
            }
        context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, options)
        } ?: throw ImageLoadException("failed to open image: $uri")
        if (options.outWidth <= 0 || options.outHeight <= 0) {
            throw ImageLoadException("failed to read image bounds: $uri")
        }
        val orientation =
            try {
                context.contentResolver.openInputStream(uri)?.use {
                    ExifInterface(it).getAttributeInt(
                        ExifInterface.TAG_ORIENTATION,
                        ExifInterface.ORIENTATION_NORMAL,
                    )
                } ?: ExifInterface.ORIENTATION_NORMAL
            } catch (err: Exception) {
                // EXIF が読めない画像でもデコードは続行する
                Log.w(LOG_TAG, "failed to read EXIF orientation", err)
                ExifInterface.ORIENTATION_NORMAL
            }
        val swapped =
            orientation == ExifInterface.ORIENTATION_ROTATE_90 ||
                orientation == ExifInterface.ORIENTATION_ROTATE_270 ||
                orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
                orientation == ExifInterface.ORIENTATION_TRANSVERSE
        return if (swapped) {
            OrientedSize(options.outHeight, options.outWidth, orientation)
        } else {
            OrientedSize(options.outWidth, options.outHeight, orientation)
        }
    }

    private fun calculateInSampleSize(
        width: Int,
        height: Int,
        targetWidth: Int,
        targetHeight: Int,
    ): Int {
        var sample = 1
        while (width / (sample * 2) >= targetWidth && height / (sample * 2) >= targetHeight) {
            sample *= 2
        }
        return sample
    }

    private fun applyOrientation(
        source: Bitmap,
        orientation: Int,
    ): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(FLIP_SCALE, NORMAL_SCALE)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(ROTATE_180_DEGREES)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                matrix.setRotate(ROTATE_180_DEGREES)
                matrix.postScale(FLIP_SCALE, NORMAL_SCALE)
            }
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.setRotate(ROTATE_90_DEGREES)
                matrix.postScale(FLIP_SCALE, NORMAL_SCALE)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(ROTATE_90_DEGREES)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.setRotate(ROTATE_MINUS_90_DEGREES)
                matrix.postScale(FLIP_SCALE, NORMAL_SCALE)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(ROTATE_MINUS_90_DEGREES)
            else -> return source
        }
        val rotated =
            Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
        if (rotated !== source) {
            source.recycle()
        }
        return rotated
    }

    private fun flattenOnWhite(
        source: Bitmap,
        width: Int,
        height: Int,
    ): Bitmap {
        val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        canvas.drawColor(Color.WHITE)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
        canvas.drawBitmap(source, null, Rect(0, 0, width, height), paint)
        return output
    }

    private data class DecodedImage(
        val bitmap: Bitmap,
        val width: Int,
        val height: Int,
        val scaled: Boolean,
    )

    private data class OrientedSize(
        val width: Int,
        val height: Int,
        val orientation: Int,
    )

    private companion object {
        const val LOG_TAG = "ImageLoader"
        const val FLIP_SCALE = -1f
        const val NORMAL_SCALE = 1f
        const val ROTATE_180_DEGREES = 180f
        const val ROTATE_90_DEGREES = 90f
        const val ROTATE_MINUS_90_DEGREES = -90f
    }
}
