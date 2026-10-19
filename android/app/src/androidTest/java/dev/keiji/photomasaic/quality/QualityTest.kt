@file:Suppress("MagicNumber", "TooManyFunctions")

package dev.keiji.photomasaic.quality

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.keiji.photomasaic.core.GenerationEvent
import dev.keiji.photomasaic.core.JsCoreEngine
import dev.keiji.photomasaic.core.RgbaImage
import dev.keiji.photomasaic.core.TileInput
import dev.keiji.photomasaic.io.AndroidImageLoader
import dev.keiji.photomasaic.io.ImageExporter
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

/** A3 品質確認(オフライン・決定性・EXIF 不在・性能・転送)の実機テスト。 */
@RunWith(AndroidJUnit4::class)
class QualityTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val temporaryFiles = mutableListOf<File>()

    @After
    fun tearDown() {
        temporaryFiles.forEach { it.delete() }
    }

    @Test
    fun manifestDoesNotRequestInternet() {
        @Suppress("DEPRECATION")
        val info =
            context.packageManager.getPackageInfo(
                context.packageName,
                PackageManager.GET_PERMISSIONS,
            )
        val permissions = info.requestedPermissions?.toSet() ?: emptySet()
        assertFalse(permissions.contains(Manifest.permission.INTERNET))
        assertFalse(permissions.contains(Manifest.permission.ACCESS_NETWORK_STATE))
    }

    @Test
    fun sameInputProducesIdenticalOutputAndContiguousBatches() =
        runBlocking {
            val engine = JsCoreEngine(context)
            try {
                assertTrue(engine.start() is dev.keiji.photomasaic.core.CoreStartupResult.Ready)
                prepareMosaic(engine, mainWidth = 96, mainHeight = 64, tileCount = 4)
                val first = runAndHash(engine)
                val second = runAndHash(engine)
                assertEquals(first.hash, second.hash)
                assertEquals(first.width, second.width)
                assertEquals(first.height, second.height)
                assertContiguousBatches(first.batches)
            } finally {
                engine.close()
            }
        }

    @Test
    fun engineCanRestartAfterIsolateClose() =
        runBlocking {
            val engine = JsCoreEngine(context)
            try {
                assertTrue(engine.start() is dev.keiji.photomasaic.core.CoreStartupResult.Ready)
                engine.close()
                assertTrue(engine.start() is dev.keiji.photomasaic.core.CoreStartupResult.Ready)
            } finally {
                engine.close()
            }
        }

    @Test
    fun exportedPngHasNoExifMetadata() =
        runBlocking {
            val input = createGpsJpeg()
            val loaded = AndroidImageLoader(context).loadMainImage(Uri.fromFile(input))
            val exporter = ImageExporter(context)
            val uri = exporter.savePng(loaded.bitmap)
            try {
                val exif =
                    context.contentResolver.openInputStream(uri)?.use {
                        ExifInterface(it)
                    }
                assertNotNull(exif)
                assertNoMetadata(exif!!)
            } finally {
                context.contentResolver.delete(uri, null, null)
                loaded.bitmap.recycle()
            }
        }

    @Test
    fun bulkRegistrationKeepsValidTilesWhenOneFails() =
        runBlocking {
            val engine = JsCoreEngine(context)
            try {
                assertTrue(engine.start() is dev.keiji.photomasaic.core.CoreStartupResult.Ready)
                engine.setMainImage(patternedRgba(64, 48))
                val valid = tileInputs(1).single()
                val invalid =
                    valid.copy(
                        id = 2,
                        feature = RgbaImage(31, 31, ByteArray(31 * 31 * BYTES_PER_PIXEL)),
                    )
                val result = engine.addTiles(listOf(valid, invalid))
                assertEquals(1, result.tiles.size)
                assertEquals(1, result.errors.size)
            } finally {
                engine.close()
            }
        }

    @Test
    fun metricsReportAllPhasesAndConfiguration() =
        runBlocking {
            val engine = JsCoreEngine(context)
            try {
                assertTrue(engine.start() is dev.keiji.photomasaic.core.CoreStartupResult.Ready)
                prepareMosaic(engine, mainWidth = 96, mainHeight = 64, tileCount = 4)
                runAndHash(engine)
                val metrics = JSONObject(engine.getMetrics())
                assertTrue(metrics.getString("core_version").isNotBlank())
                val runs = metrics.getJSONArray("runs")
                assertTrue(runs.length() >= 1)
                val run = runs.getJSONObject(runs.length() - 1)
                val phases = run.getJSONObject("phases")
                for (phase in PHASES) {
                    assertTrue("missing phase: $phase", phases.has(phase))
                }
                val config = run.getJSONObject("config")
                assertTrue(config.getInt("block_size") > 0)
                assertTrue(run.getJSONObject("memory").getInt("tiles_bytes") > 0)
            } finally {
                engine.close()
            }
        }

    @Test
    fun sMidPerformanceAndTransferAreRecorded() =
        runBlocking {
            val engine = JsCoreEngine(context)
            try {
                assertTrue(engine.start() is dev.keiji.photomasaic.core.CoreStartupResult.Ready)
                val mainStart = System.nanoTime()
                engine.setMainImage(patternedRgba(S_MID_WIDTH, S_MID_HEIGHT))
                val mainMs = elapsedMs(mainStart)

                val tileStart = System.nanoTime()
                engine.addTiles(tileInputs(S_MID_TILES))
                val tileMs = elapsedMs(tileStart)

                val runStart = System.nanoTime()
                val result = runAndHash(engine)
                val runMs = elapsedMs(runStart)
                val metrics = JSONObject(engine.getMetrics())
                val run = metrics.getJSONArray("runs").getJSONObject(0)
                println(
                    "A3_TIMING name=S-mid main_ms=$mainMs tiles_ms=$tileMs run_ms=$runMs " +
                        "main_bytes=${S_MID_WIDTH * S_MID_HEIGHT * BYTES_PER_PIXEL} tiles=$S_MID_TILES " +
                        "phases=${run.getJSONObject("phases")}",
                )
                assertEquals(S_MID_WIDTH, result.width)
                assertEquals(S_MID_HEIGHT, result.height)
                assertContiguousBatches(result.batches)
            } finally {
                engine.close()
            }
        }

    @Test
    fun sLargeCompletesWithinIsolateMemory() =
        runBlocking {
            val engine = JsCoreEngine(context)
            try {
                assertTrue(engine.start() is dev.keiji.photomasaic.core.CoreStartupResult.Ready)
                val mainStart = System.nanoTime()
                engine.setMainImage(patternedRgba(S_LARGE_WIDTH, S_LARGE_HEIGHT))
                val mainMs = elapsedMs(mainStart)

                val tileStart = System.nanoTime()
                engine.addTiles(tileInputs(S_LARGE_TILES))
                val tileMs = elapsedMs(tileStart)

                val runStart = System.nanoTime()
                val result = runAndHash(engine)
                val runMs = elapsedMs(runStart)
                val metrics = JSONObject(engine.getMetrics())
                val run = metrics.getJSONArray("runs").getJSONObject(0)
                println(
                    "A3_TIMING name=S-large main_ms=$mainMs tiles_ms=$tileMs run_ms=$runMs " +
                        "main_bytes=${S_LARGE_WIDTH * S_LARGE_HEIGHT * BYTES_PER_PIXEL} tiles=$S_LARGE_TILES " +
                        "phases=${run.getJSONObject("phases")} " +
                        "tiles_bytes=${run.getJSONObject("memory").getInt("tiles_bytes")}",
                )
                assertEquals(S_LARGE_WIDTH, result.width)
                assertEquals(S_LARGE_HEIGHT, result.height)
                assertContiguousBatches(result.batches)
            } finally {
                engine.close()
            }
        }

    private suspend fun prepareMosaic(
        engine: JsCoreEngine,
        mainWidth: Int,
        mainHeight: Int,
        tileCount: Int,
    ) {
        engine.setMainImage(patternedRgba(mainWidth, mainHeight))
        engine.addTiles(tileInputs(tileCount))
    }

    private fun tileInputs(count: Int): List<TileInput> =
        List(count) { index ->
            val id = index + 1L
            val seed = id.toInt()
            TileInput(
                id = id,
                feature = patternedRgba(FEATURE_SIZE, FEATURE_SIZE, seed),
                compose = patternedRgba(COMPOSE_SIZE, COMPOSE_SIZE, seed + 17),
            )
        }

    private suspend fun runAndHash(engine: JsCoreEngine): RunResult {
        val batchRanges = mutableListOf<IntRange>()
        var completed: RgbaImage? = null
        withTimeout(TEST_TIMEOUT_MS) {
            engine.run().collect { event ->
                when (event) {
                    is GenerationEvent.Batch -> {
                        batchRanges += event.batch.blockRowBegin until event.batch.blockRowEnd
                    }
                    is GenerationEvent.Completed -> completed = event.image
                    else -> Unit
                }
            }
        }
        val image = requireNotNull(completed)
        return RunResult(image.width, image.height, sha256(image.data), batchRanges)
    }

    private fun assertContiguousBatches(batches: List<IntRange>) {
        assertTrue("batch list is empty", batches.isNotEmpty())
        var nextRow = 0
        for (batch in batches) {
            assertEquals(nextRow, batch.first)
            assertTrue(batch.last >= batch.first)
            nextRow = batch.last + 1
        }
        assertTrue(nextRow > 0)
    }

    private fun assertNoMetadata(exif: ExifInterface) {
        val tags =
            listOf(
                ExifInterface.TAG_GPS_LATITUDE,
                ExifInterface.TAG_GPS_LATITUDE_REF,
                ExifInterface.TAG_GPS_LONGITUDE,
                ExifInterface.TAG_GPS_LONGITUDE_REF,
                ExifInterface.TAG_MAKE,
                ExifInterface.TAG_MODEL,
                ExifInterface.TAG_DATETIME,
                ExifInterface.TAG_IMAGE_DESCRIPTION,
            )
        for (tag in tags) {
            assertEquals("unexpected metadata: $tag", null, exif.getAttribute(tag))
        }
    }

    private fun createGpsJpeg(): File {
        val file = File(context.cacheDir, "a3-gps-${System.nanoTime()}.jpg")
        temporaryFiles += file
        val bitmap = Bitmap.createBitmap(32, 24, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.GREEN)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        bitmap.recycle()
        ExifInterface(file.absolutePath).apply {
            setAttribute(ExifInterface.TAG_GPS_LATITUDE, "35/1")
            setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE, "139/1")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, "E")
            setAttribute(ExifInterface.TAG_MAKE, "A3-Test")
            setAttribute(ExifInterface.TAG_MODEL, "Quality")
            saveAttributes()
        }
        return file
    }

    private fun patternedRgba(
        width: Int,
        height: Int,
        seed: Int = 0,
    ): RgbaImage {
        val data = ByteArray(width * height * BYTES_PER_PIXEL)
        var offset = 0
        for (y in 0 until height) {
            for (x in 0 until width) {
                data[offset++] = ((x * 3 + seed * 11) and CHANNEL_MASK).toByte()
                data[offset++] = ((y * 5 + seed * 7) and CHANNEL_MASK).toByte()
                data[offset++] = ((x + y + seed * 13) and CHANNEL_MASK).toByte()
                data[offset++] = 0xff.toByte()
            }
        }
        return RgbaImage(width, height, data)
    }

    private fun elapsedMs(start: Long): Long = (System.nanoTime() - start) / NANOS_PER_MS

    private fun sha256(bytes: ByteArray): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    private data class RunResult(
        val width: Int,
        val height: Int,
        val hash: String,
        val batches: List<IntRange>,
    )

    private companion object {
        val PHASES = listOf("P1_MAIN_ANALYZE", "P2_TILE_ANALYZE", "P3_MATCH", "P4_COMPOSE")
        const val BYTES_PER_PIXEL = 4
        const val CHANNEL_MASK = 0xff
        const val FEATURE_SIZE = 32
        const val COMPOSE_SIZE = 16
        const val NANOS_PER_MS = 1_000_000L
        const val TEST_TIMEOUT_MS = 600_000L
        const val S_MID_WIDTH = 4000
        const val S_MID_HEIGHT = 3000
        const val S_MID_TILES = 300
        const val S_LARGE_WIDTH = 4000
        const val S_LARGE_HEIGHT = 3000
        const val S_LARGE_TILES = 2000
    }
}
