package dev.keiji.photomasaic.ui.startup

import dev.keiji.photomasaic.core.CoreEngine
import dev.keiji.photomasaic.core.CoreStartupResult
import dev.keiji.photomasaic.core.GenerationEvent
import dev.keiji.photomasaic.core.GridInfo
import dev.keiji.photomasaic.core.MosaicConfig
import dev.keiji.photomasaic.core.RgbaImage
import dev.keiji.photomasaic.core.TileBatchResult
import dev.keiji.photomasaic.core.TileInfo
import dev.keiji.photomasaic.core.TileInput
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class StartupViewModelTest {
    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun readyResultBecomesReadyState() {
        val viewModel = StartupViewModel(FakeCoreEngine(CoreStartupResult.Ready("photomosaic-core 0.1.0")))
        assertEquals(StartupUiState.Ready("photomosaic-core 0.1.0"), viewModel.uiState.value)
    }

    @Test
    fun sandboxUnsupportedBecomesGuidanceState() {
        val viewModel = StartupViewModel(FakeCoreEngine(CoreStartupResult.SandboxUnsupported))
        assertEquals(StartupUiState.SandboxUnsupported, viewModel.uiState.value)
    }

    @Test
    fun webAssemblyUnavailableBecomesGuidanceState() {
        val viewModel = StartupViewModel(FakeCoreEngine(CoreStartupResult.WebAssemblyUnavailable))
        assertEquals(StartupUiState.WebAssemblyUnavailable, viewModel.uiState.value)
    }

    @Test
    fun failureCarriesMessage() {
        val viewModel = StartupViewModel(FakeCoreEngine(CoreStartupResult.Failed("boom")))
        assertEquals(StartupUiState.Failed("boom"), viewModel.uiState.value)
    }

    @Test
    fun retryRunsStartupAgain() {
        val engine = FakeCoreEngine(CoreStartupResult.Failed("boom"))
        val viewModel = StartupViewModel(engine)
        assertEquals(StartupUiState.Failed("boom"), viewModel.uiState.value)

        engine.result = CoreStartupResult.Ready("photomosaic-core 0.1.0")
        viewModel.check()

        assertEquals(2, engine.starts)
        assertEquals(StartupUiState.Ready("photomosaic-core 0.1.0"), viewModel.uiState.value)
    }
}

private class FakeCoreEngine(
    var result: CoreStartupResult,
) : CoreEngine {
    var starts = 0

    override suspend fun start(): CoreStartupResult {
        starts += 1
        return result
    }

    override suspend fun setMainImage(image: RgbaImage): GridInfo = notUsed()

    override suspend fun setBlockSize(px: Int): GridInfo = notUsed()

    override suspend fun getBlockMeanColors(): ByteArray = notUsed()

    override suspend fun addTile(
        id: Long,
        feature: RgbaImage,
        compose: RgbaImage,
    ): TileInfo = notUsed()

    override suspend fun addTiles(tiles: List<TileInput>): TileBatchResult = notUsed()

    override suspend fun removeTile(id: Long) = notUsed()

    override suspend fun clearTiles() = notUsed()

    override suspend fun clearMainImage() = notUsed()

    override fun run(): Flow<GenerationEvent> = notUsed()

    override fun rematch(): Flow<GenerationEvent> = notUsed()

    override suspend fun cancel() = notUsed()

    override suspend fun getMetrics(): String = notUsed()

    override suspend fun getConfig(): MosaicConfig = notUsed()

    override suspend fun setConfig(config: MosaicConfig) = notUsed()

    override fun close() = Unit

    private fun notUsed(): Nothing = throw UnsupportedOperationException("not used in this test")
}
