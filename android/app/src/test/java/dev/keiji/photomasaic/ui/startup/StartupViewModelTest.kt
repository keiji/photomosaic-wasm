package dev.keiji.photomasaic.ui.startup

import dev.keiji.photomasaic.core.CoreEngine
import dev.keiji.photomasaic.core.CoreStartupResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
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

    override fun close() = Unit
}
