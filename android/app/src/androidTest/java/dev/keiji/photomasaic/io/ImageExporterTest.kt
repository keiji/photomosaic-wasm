@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.io

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Date

/** MediaStore 保存と FileProvider 共有の実機テスト(A1)。 */
@RunWith(AndroidJUnit4::class)
class ImageExporterTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val exporter = ImageExporter(context)
    private val bitmaps = mutableListOf<Bitmap>()

    @After
    fun tearDown() {
        bitmaps.forEach { it.recycle() }
        File(context.cacheDir, SHARE_CACHE_DIR).deleteRecursively()
    }

    @Test
    fun savePngWritesReadableEntry() =
        runBlocking {
            val bitmap = createBitmap(Color.MAGENTA)
            val uri = exporter.savePng(bitmap, Date(0L))
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    assertTrue(uri.toString().startsWith("content://"))
                } else {
                    assertEquals("file", uri.scheme)
                    val path = requireNotNull(uri.path)
                    assertTrue(path.contains(EXPORT_RELATIVE_PATH))
                    assertTrue(File(path).isFile)
                }
                val bytes =
                    context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                assertNotNull(bytes)
                assertTrue(bytes!!.isNotEmpty())
            } finally {
                deleteSaved(uri)
            }
        }

    @Test
    fun savePngIsListedInMediaStore() =
        runBlocking {
            val bitmap = createBitmap(Color.YELLOW)
            val fileName = buildFileName(Date(0L))
            val uri = exporter.savePng(bitmap, Date(0L))
            try {
                assertTrue("saved image is not listed in MediaStore", waitForMediaStore(fileName))
            } finally {
                deleteSaved(uri)
            }
        }

    @Test
    fun shareIntentUsesFileProvider() {
        val bitmap = createBitmap(Color.CYAN)
        val intent = exporter.createShareIntent(bitmap, Date(0L))
        assertEquals("image/png", intent.type)
        @Suppress("DEPRECATION")
        val uri: Uri = requireNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM))
        assertEquals("content", uri.scheme)
        assertEquals("${context.packageName}.fileprovider", uri.authority)
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        assertNotNull(bytes)
        assertTrue(bytes!!.isNotEmpty())
    }

    private fun deleteSaved(uri: Uri) {
        if (uri.scheme == "content") {
            context.contentResolver.delete(uri, null, null)
        } else {
            val path = uri.path ?: return
            val file = File(path)
            val fileName = file.name
            file.delete()
            // API 26〜28 はファイル削除だけでは MediaStore の走査結果が残るため、
            // 同じ表示名のエントリも削除してテスト間の干渉を防ぐ。
            context.contentResolver.delete(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                "${MediaStore.Images.Media.DISPLAY_NAME} = ?",
                arrayOf(fileName),
            )
        }
    }

    private fun waitForMediaStore(fileName: String): Boolean {
        val projection = arrayOf(MediaStore.Images.Media._ID)
        val selection = "${MediaStore.Images.Media.DISPLAY_NAME} = ?"
        repeat(MEDIA_STORE_POLL_COUNT) {
            val found =
                context.contentResolver
                    .query(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        projection,
                        selection,
                        arrayOf(fileName),
                        null,
                    )?.use { it.count > 0 } ?: false
            if (found) {
                return true
            }
            Thread.sleep(MEDIA_STORE_POLL_INTERVAL_MS)
        }
        return false
    }

    private fun createBitmap(color: Int): Bitmap =
        Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888).apply {
            eraseColor(color)
            bitmaps += this
        }

    private companion object {
        const val MEDIA_STORE_POLL_COUNT = 50
        const val MEDIA_STORE_POLL_INTERVAL_MS = 100L
    }
}
