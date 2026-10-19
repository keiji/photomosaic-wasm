@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.io

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** 端末内デコード・正規化・EXIF 反映の実機テスト(A1)。 */
@RunWith(AndroidJUnit4::class)
class ImageLoaderTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val loader = AndroidImageLoader(context)
    private val temporaryFiles = mutableListOf<File>()

    @After
    fun tearDown() {
        temporaryFiles.forEach { it.delete() }
    }

    @Test
    fun mainImageIsDownscaledTo4096() =
        runBlocking {
            val loaded = loader.loadMainImage(Uri.fromFile(createPng(5000, 100, Color.RED)))
            assertEquals(4096, loaded.width)
            assertEquals(82, loaded.height)
            assertTrue(loaded.scaled)
            loaded.bitmap.recycle()
        }

    @Test
    fun tileThumbsUse64And32() =
        runBlocking {
            val loaded = loader.loadTile(Uri.fromFile(createPng(128, 64, Color.RED)))
            assertEquals(TILE_COMPOSE_THUMB_MAX, loaded.compose.width)
            assertEquals(32, loaded.compose.height)
            assertEquals(TILE_FEATURE_THUMB * TILE_FEATURE_THUMB, loaded.feature.size)
            assertTrue(loaded.feature.all { (it and 0x00FFFFFF) == 0x00FF0000 })
            loaded.compose.recycle()
        }

    @Test
    fun exifRotationSwapsDimensions() =
        runBlocking {
            val file = File(context.cacheDir, "test-${System.nanoTime()}.jpg")
            temporaryFiles += file
            val bitmap = Bitmap.createBitmap(120, 60, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.GREEN)
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
            bitmap.recycle()
            ExifInterface(file.absolutePath).apply {
                setAttribute(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_ROTATE_90.toString(),
                )
                saveAttributes()
            }

            val loaded = loader.loadMainImage(Uri.fromFile(file))
            assertEquals(60, loaded.width)
            assertEquals(120, loaded.height)
            loaded.bitmap.recycle()
        }

    private fun createPng(
        width: Int,
        height: Int,
        color: Int,
    ): File {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(color)
        val file = File(context.cacheDir, "test-${System.nanoTime()}.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        temporaryFiles += file
        return file
    }
}
