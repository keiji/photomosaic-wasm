@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.io

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
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
                assertTrue(uri.toString().startsWith("content://"))
                val bytes =
                    context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                assertNotNull(bytes)
                assertTrue(bytes!!.isNotEmpty())
            } finally {
                context.contentResolver.delete(uri, null, null)
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

    private fun createBitmap(color: Int): Bitmap =
        Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888).apply {
            eraseColor(color)
            bitmaps += this
        }
}
