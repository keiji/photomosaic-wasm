@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.ui.editor

import android.graphics.Bitmap
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.keiji.photomasaic.io.ImageLoadException
import dev.keiji.photomasaic.io.ImageLoader
import dev.keiji.photomasaic.io.LoadedMainImage
import dev.keiji.photomasaic.io.LoadedTile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** S1 開始画面 ViewModel の状態遷移テスト(A1)。 */
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
        runTest {
            val viewModel = EditorViewModel("v", FakeImageLoader(mainBitmap, tileBitmap))
            viewModel.setMainImage(Uri.parse("content://test/main"))
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
        }

    @Test
    fun addTilesAppendsAndRemoves() =
        runTest {
            val viewModel = EditorViewModel("v", FakeImageLoader(mainBitmap, tileBitmap))
            viewModel.addTiles(listOf(Uri.parse("content://test/1"), Uri.parse("content://test/2")))
            assertEquals(2, viewModel.uiState.value.tiles.size)

            val firstId =
                viewModel.uiState.value.tiles
                    .first()
                    .id
            viewModel.removeTile(firstId)
            assertEquals(1, viewModel.uiState.value.tiles.size)
        }

    @Test
    fun decodeFailureSetsError() =
        runTest {
            val viewModel = EditorViewModel("v", FakeImageLoader(mainBitmap, tileBitmap, fail = true))
            viewModel.setMainImage(Uri.parse("content://test/main"))
            assertEquals(EditorError.DecodeFailed, viewModel.uiState.value.error)
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
