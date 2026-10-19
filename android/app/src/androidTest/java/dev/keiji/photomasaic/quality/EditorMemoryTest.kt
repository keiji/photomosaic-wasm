@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.quality

import android.graphics.Bitmap
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.keiji.photomasaic.core.JsCoreEngine
import dev.keiji.photomasaic.io.ImageExporter
import dev.keiji.photomasaic.io.ImageLoader
import dev.keiji.photomasaic.io.LoadedMainImage
import dev.keiji.photomasaic.io.LoadedTile
import dev.keiji.photomasaic.ui.editor.EditorViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** 12MP のメイン画像をアプリ層(ViewModel + Bitmap)で扱っても OOM しないこと(A3)。 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class EditorMemoryTest {
    private lateinit var mainBitmap: Bitmap
    private lateinit var tileBitmap: Bitmap
    private lateinit var engine: JsCoreEngine

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        mainBitmap = Bitmap.createBitmap(MAIN_WIDTH, MAIN_HEIGHT, Bitmap.Config.ARGB_8888)
        tileBitmap = Bitmap.createBitmap(TILE_SIZE, TILE_SIZE, Bitmap.Config.ARGB_8888)
        engine = JsCoreEngine(ApplicationProvider.getApplicationContext())
    }

    @After
    fun tearDown() {
        engine.close()
        Dispatchers.resetMain()
        mainBitmap.recycle()
        tileBitmap.recycle()
    }

    @Test
    fun generates12MpImageWithoutOom() =
        runBlocking {
            assertTrue(
                engine.start() is dev.keiji.photomasaic.core.CoreStartupResult.Ready,
            )
            val viewModel =
                EditorViewModel(
                    coreVersion = "v",
                    core = engine,
                    imageLoader = FakeLargeImageLoader(mainBitmap, tileBitmap),
                    exporter = ImageExporter(ApplicationProvider.getApplicationContext()),
                )
            viewModel.setMainImage(Uri.parse("content://test/main"))
            await { viewModel.uiState.value.grid != null }
            viewModel.addTiles(List(APP_TILE_COUNT) { Uri.parse("content://test/tile/$it") })
            await { viewModel.uiState.value.loading == null }
            viewModel.enterEdit()
            await { viewModel.uiState.value.resultReady && viewModel.uiState.value.metrics != null }
            assertTrue(viewModel.uiState.value.preview != null)
            assertEquals(
                "done",
                viewModel.uiState.value.progress
                    ?.phaseCode,
            )
            assertTrue(
                viewModel.uiState.value.metrics
                    ?.summary
                    ?.contains("trigger:") == true,
            )
        }

    private suspend fun await(predicate: () -> Boolean) {
        withTimeout(APP_TIMEOUT_MS) {
            while (!predicate()) {
                delay(50L)
            }
        }
    }

    private class FakeLargeImageLoader(
        private val mainBitmap: Bitmap,
        private val tileBitmap: Bitmap,
    ) : ImageLoader {
        override suspend fun loadMainImage(uri: Uri): LoadedMainImage =
            LoadedMainImage(
                bitmap = mainBitmap,
                width = mainBitmap.width,
                height = mainBitmap.height,
                scaled = false,
            )

        override suspend fun loadTile(uri: Uri): LoadedTile =
            LoadedTile(
                feature = IntArray(FEATURE_SIZE * FEATURE_SIZE),
                compose = tileBitmap,
            )
    }

    private companion object {
        const val MAIN_WIDTH = 4096
        const val MAIN_HEIGHT = 3072
        const val TILE_SIZE = 64
        const val FEATURE_SIZE = 32
        const val APP_TILE_COUNT = 50
        const val APP_TIMEOUT_MS = 180_000L
    }
}
