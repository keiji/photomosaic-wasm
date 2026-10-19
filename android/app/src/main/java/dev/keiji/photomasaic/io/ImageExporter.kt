package dev.keiji.photomasaic.io

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import dev.keiji.photomasaic.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** 保存先の Pictures 配下ディレクトリ(基本設計書 3.4) */
const val EXPORT_RELATIVE_PATH = "Pictures/Photomosaic"

/** 共有用一時ファイルのキャッシュ配下ディレクトリ */
const val SHARE_CACHE_DIR = "shared"

/** PNG の圧縮品質(PNG は可逆のため 100 固定) */
private const val PNG_QUALITY = 100

/**
 * 保存ファイル名を生成する(純関数)。
 * 書式: photomosaic_YYYYMMDD_HHMMSS.png(基本設計書 3.4)
 */
fun buildFileName(
    now: Date = Date(),
    timeZone: TimeZone = TimeZone.getDefault(),
): String {
    val format =
        SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).apply {
            this.timeZone = timeZone
        }
    return "photomosaic_${format.format(now)}.png"
}

/**
 * 完成画像の保存・共有(A1)。
 *
 * - API 29 以降: MediaStore の Pictures/Photomosaic へ PNG を書き込む(権限不要)
 * - API 26〜28: 公開 Pictures へ書き込むため WRITE_EXTERNAL_STORAGE が必要
 * - 共有: キャッシュ配下へ PNG を書き出し、FileProvider の content URI を
 *   ACTION_SEND へ渡す(画像を他アプリへ一時公開する)
 */
class ImageExporter(
    private val context: Context,
) {
    /** 完成画像を PNG で保存し、書き込み先 URI を返す */
    suspend fun savePng(
        bitmap: Bitmap,
        now: Date = Date(),
    ): Uri =
        withContext(Dispatchers.IO) {
            val fileName = buildFileName(now)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveToMediaStore(bitmap, fileName)
            } else {
                saveToLegacyPictures(bitmap, fileName)
            }
        }

    /** 共有シート用の Intent を組み立てる(一時 PNG をキャッシュへ書き出す) */
    fun createShareIntent(
        bitmap: Bitmap,
        now: Date = Date(),
    ): Intent {
        val directory = File(context.cacheDir, SHARE_CACHE_DIR).apply { mkdirs() }
        // 過去の共有ファイルを掃除してキャッシュを圧迫しない
        directory.listFiles()?.forEach { it.delete() }
        val file = File(directory, buildFileName(now))
        file.outputStream().use { output ->
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, PNG_QUALITY, output)) {
                throw IOException("failed to encode PNG for sharing")
            }
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        return Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    /** 共有シートを開く(アプリ外の Activity を起動するため NEW_TASK を付ける) */
    fun share(
        bitmap: Bitmap,
        now: Date = Date(),
    ) {
        val chooser =
            Intent.createChooser(
                createShareIntent(bitmap, now),
                context.getString(R.string.share_chooser_title),
            )
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
    }

    @Suppress("TooGenericExceptionCaught")
    private fun saveToMediaStore(
        bitmap: Bitmap,
        fileName: String,
    ): Uri {
        val values =
            ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                put(MediaStore.Images.Media.RELATIVE_PATH, EXPORT_RELATIVE_PATH)
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri =
            context.contentResolver.insert(collection, values)
                ?: throw IOException("failed to create MediaStore entry")
        try {
            writePng(bitmap, uri)
            val completed = ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }
            context.contentResolver.update(uri, completed, null, null)
        } catch (err: Exception) {
            context.contentResolver.delete(uri, null, null)
            throw err
        }
        return uri
    }

    @Suppress("DEPRECATION")
    private fun saveToLegacyPictures(
        bitmap: Bitmap,
        fileName: String,
    ): Uri {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            throw SecurityException("WRITE_EXTERNAL_STORAGE is required on API 26-28")
        }
        val directory =
            File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Photomosaic")
                .apply { mkdirs() }
        val file = File(directory, fileName)
        file.outputStream().use { output ->
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, PNG_QUALITY, output)) {
                throw IOException("failed to encode PNG")
            }
        }
        MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf("image/png"), null)
        return Uri.fromFile(file)
    }

    private fun writePng(
        bitmap: Bitmap,
        uri: Uri,
    ) {
        val output =
            context.contentResolver.openOutputStream(uri)
                ?: throw IOException("failed to open output stream: $uri")
        output.use {
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, PNG_QUALITY, it)) {
                throw IOException("failed to encode PNG")
            }
        }
    }
}
