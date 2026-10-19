@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.core

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** MessagePort 連携(A2)の実機テスト。 */
@RunWith(AndroidJUnit4::class)
class JsCoreEngineTest {
    @Test
    fun runProducesProgressBatchesAndCompletedImage() =
        runBlocking {
            val engine = JsCoreEngine(ApplicationProvider.getApplicationContext())
            try {
                val startup = engine.start()
                if (startup is CoreStartupResult.Failed &&
                    startup.message.contains("MessagePort")
                ) {
                    assumeTrue(
                        "MessagePort is unsupported by this WebView; integration test skipped",
                        false,
                    )
                }
                assertTrue("startup failed: $startup", startup is CoreStartupResult.Ready)
                val ready = startup as CoreStartupResult.Ready
                assertTrue(ready.coreVersion.isNotBlank())

                val width = 64
                val height = 48
                val main = RgbaImage(width, height, solidRgba(width, height, 96, 128, 160))
                val grid = engine.setMainImage(main)
                assertEquals(width, grid.width)
                assertEquals(height, grid.height)
                assertTrue(grid.totalBlocks > 0)

                val meanColors = engine.getBlockMeanColors()
                assertEquals(grid.totalBlocks * 3, meanColors.size)

                val tile =
                    engine.addTile(
                        id = 1L,
                        feature = RgbaImage(32, 32, solidRgba(32, 32, 200, 80, 40)),
                        compose = RgbaImage(16, 16, solidRgba(16, 16, 200, 80, 40)),
                    )
                assertEquals(1L, tile.id)

                val events = mutableListOf<GenerationEvent>()
                withTimeout(30_000L) {
                    engine.run().collect { event -> events += event }
                }

                assertTrue("progress event missing", events.any { it is GenerationEvent.Progress })
                assertTrue("batch event missing", events.any { it is GenerationEvent.Batch })
                val completed =
                    events
                        .filterIsInstance<GenerationEvent.Completed>()
                        .singleOrNull()
                assertTrue("completed event missing: $events", completed != null)
                assertEquals(width, completed?.image?.width)
                assertEquals(height, completed?.image?.height)
                assertEquals(width * height * 4, completed?.image?.data?.size)
            } finally {
                engine.close()
            }
        }

    private fun solidRgba(
        width: Int,
        height: Int,
        red: Int,
        green: Int,
        blue: Int,
    ): ByteArray {
        val data = ByteArray(width * height * 4)
        var offset = 0
        repeat(width * height) {
            data[offset++] = red.toByte()
            data[offset++] = green.toByte()
            data[offset++] = blue.toByte()
            data[offset++] = 0xff.toByte()
        }
        return data
    }
}
