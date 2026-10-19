@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.ui.editor

import android.graphics.Bitmap
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.keiji.photomasaic.core.CoreEngine
import dev.keiji.photomasaic.core.CoreStartupResult
import dev.keiji.photomasaic.core.GenerationEvent
import dev.keiji.photomasaic.core.GridInfo
import dev.keiji.photomasaic.core.MosaicConfig
import dev.keiji.photomasaic.core.ProgressEvent
import dev.keiji.photomasaic.core.RgbaImage
import dev.keiji.photomasaic.core.TileInfo
import dev.keiji.photomasaic.io.ImageExporter
import dev.keiji.photomasaic.io.ImageLoadException
import dev.keiji.photomasaic.io.ImageLoader
import dev.keiji.photomasaic.io.LoadedMainImage
import dev.keiji.photomasaic.io.LoadedTile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
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

/** S1/S2 画面 ViewModel の状態遷移テスト(A1/A2)。 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class EditorViewModelTest {
    private lateinit var mainBitmap: Bitmap
    private lateinit var tileBitmap: Bitmap

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        mainBitmap = Bitmap.createBitmap(100, 50, Bitmap.Config.ARGB_8888)
        tileBitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        mainBitmap.recycle()
        tileBitmap.recycle()
    }

    @Test
    fun setMainImageUpdatesState() =
        runBlocking {
            val viewModel = createViewModel(FakeImageLoader(mainBitmap, tileBitmap))
            viewModel.setMainImage(Uri.parse("content://test/main"))
            await { viewModel.uiState.value.mainImage != null }
            assertEquals(
                100,
                viewModel.uiState.value.mainImage
                    ?.width,
            )
            assertEquals(
                50,
                viewModel.uiState.value.mainImage
                    ?.height,
            )
            assertEquals(EditorStage.Start, viewModel.uiState.value.screen)
        }

    @Test
    fun addTilesAppendsAndRemoves() =
        runBlocking {
            val viewModel = createViewModel(FakeImageLoader(mainBitmap, tileBitmap))
            viewModel.addTiles(listOf(Uri.parse("content://test/1"), Uri.parse("content://test/2")))
            await { viewModel.uiState.value.loading == null && viewModel.uiState.value.tiles.size == 2 }
            assertEquals(2, viewModel.uiState.value.tiles.size)

            val firstId =
                viewModel.uiState.value.tiles
                    .first()
                    .id
            viewModel.removeTile(firstId)
            await { viewModel.uiState.value.tiles.size == 1 }
            assertEquals(1, viewModel.uiState.value.tiles.size)
        }

    @Test
    fun decodeFailureSetsError() =
        runBlocking {
            val viewModel = createViewModel(FakeImageLoader(mainBitmap, tileBitmap, fail = true))
            viewModel.setMainImage(Uri.parse("content://test/main"))
            await { viewModel.uiState.value.error != null }
            assertEquals(EditorError.DecodeFailed, viewModel.uiState.value.error)
        }

    @Test
    fun enterEditGeneratesAndEnablesSave() =
        runBlocking {
            val viewModel = createViewModel(FakeImageLoader(mainBitmap, tileBitmap))
            viewModel.setMainImage(Uri.parse("content://test/main"))
            await { viewModel.uiState.value.grid != null }
            viewModel.addTiles(listOf(Uri.parse("content://test/1")))
            await { viewModel.uiState.value.tiles.size == 1 }
            viewModel.enterEdit()
            await { viewModel.uiState.value.resultReady }
            assertEquals(EditorStage.Edit, viewModel.uiState.value.screen)
            assertTrue(viewModel.uiState.value.preview != null)
            assertEquals(
                viewModel.uiState.value.grid
                    ?.totalBlocks,
                viewModel.uiState.value.progress
                    ?.assignedBlocks,
            )
        }

    private fun createViewModel(loader: ImageLoader): EditorViewModel =
        EditorViewModel(
            coreVersion = "v",
            core = FakeCoreEngine(),
            imageLoader = loader,
            exporter = ImageExporter(ApplicationProvider.getApplicationContext()),
        )

    private suspend fun await(predicate: () -> Boolean) {
        withTimeout(5_000L) {
            while (!predicate()) {
                delay(10L)
            }
        }
    }
}

private class FakeCoreEngine : CoreEngine {
    private var width = 0
    private var height = 0

    override suspend fun start(): CoreStartupResult = CoreStartupResult.Ready("v")

    override suspend fun setMainImage(image: RgbaImage): GridInfo {
        width = image.width
        height = image.height
        return grid()
    }

    override suspend fun setBlockSize(px: Int): GridInfo = grid()

    override suspend fun getBlockMeanColors(): ByteArray {
        val total = grid().totalBlocks
        return ByteArray(total * 3) { 128.toByte() }
    }

    override suspend fun addTile(
        id: Long,
        feature: RgbaImage,
        compose: RgbaImage,
    ): TileInfo =
        TileInfo(
            id = id,
            thumbWidth = compose.width,
            thumbHeight = compose.height,
            meanLab = floatArrayOf(0f, 0f, 0f),
            detail = 0f,
            usage = 0,
        )

    override suspend fun removeTile(id: Long) = Unit

    override suspend fun clearTiles() = Unit

    override suspend fun clearMainImage() = Unit

    override fun run(): Flow<GenerationEvent> = generationFlow()

    override fun rematch(): Flow<GenerationEvent> = generationFlow()

    override suspend fun cancel() = Unit

    override suspend fun getConfig(): MosaicConfig = MosaicConfig()

    override suspend fun setConfig(config: MosaicConfig) = Unit

    override fun close() = Unit

    private fun grid(): GridInfo {
        val block = 24
        val cols = (width + block - 1) / block
        val rows = (height + block - 1) / block
        return GridInfo(width, height, block, cols, rows, cols * rows)
    }

    private fun generationFlow(): Flow<GenerationEvent> =
        flow {
            val grid = grid()
            emit(
                GenerationEvent.Progress(
                    ProgressEvent("match", 1f, 1f, grid.totalBlocks, grid.totalBlocks),
                ),
            )
            emit(
                GenerationEvent.Completed(
                    RgbaImage(grid.width, grid.height, ByteArray(grid.width * grid.height * 4)),
                ),
            )
        }
}

private class FakeImageLoader(
    private val mainBitmap: Bitmap,
    private val tileBitmap: Bitmap,
    private val fail: Boolean = false,
) : ImageLoader {
    override suspend fun loadMainImage(uri: Uri): LoadedMainImage {
        if (fail) {
            throw ImageLoadException("failed")
        }
        return LoadedMainImage(mainBitmap, mainBitmap.width, mainBitmap.height, scaled = false)
    }

    override suspend fun loadTile(uri: Uri): LoadedTile {
        if (fail) {
            throw ImageLoadException("failed")
        }
        return LoadedTile(IntArray(32 * 32), tileBitmap)
    }
}
