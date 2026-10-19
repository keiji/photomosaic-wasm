@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.ui.editor

import android.content.ClipboardManager
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.keiji.photomasaic.R
import dev.keiji.photomasaic.core.GridInfo
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** S1 開始画面・S2 編集画面の表示内容テスト(A1/A2)。 */
@RunWith(AndroidJUnit4::class)
class EditorScreenTest {
    @get:Rule val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun emptyStateShowsPickerButtons() {
        composeTestRule.setContent {
            EditorScreen(
                state = EditorUiState(coreVersion = "v"),
                actions = EditorActions(),
            )
        }
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_main_image_select))
            .assertExists()
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_tiles_add))
            .assertExists()
    }

    @Test
    fun filledStateShowsSizeAndCount() {
        val mainBitmap = Bitmap.createBitmap(100, 50, Bitmap.Config.ARGB_8888)
        val tileBitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        composeTestRule.setContent {
            EditorScreen(
                state =
                    EditorUiState(
                        coreVersion = "v",
                        mainImage = MainImageUi(mainBitmap, 100, 50, scaled = false),
                        tiles = listOf(TileUi(1L, tileBitmap)),
                    ),
                actions = EditorActions(),
            )
        }
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_image_size, 100, 50))
            .assertExists()
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_tiles_count, 1))
            .assertExists()
    }

    @Test
    fun editStateShowsProgressAndSave() {
        val preview = Bitmap.createBitmap(100, 50, Bitmap.Config.ARGB_8888)
        val tileBitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        composeTestRule.setContent {
            EditorScreen(
                state =
                    EditorUiState(
                        coreVersion = "v",
                        screen = EditorStage.Edit,
                        mainImage = MainImageUi(preview, 100, 50, scaled = false),
                        tiles = listOf(TileUi(1L, tileBitmap)),
                        grid = GridInfo(100, 50, 24, 5, 3, 15),
                        preview = preview,
                        progress = GenerationProgressUi("match", 0.5f, 0.5f, 8, 15),
                        resultReady = true,
                        config =
                            dev.keiji.photomasaic.core
                                .MosaicConfig(),
                    ),
                actions = EditorActions(),
            )
        }
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_progress_title))
            .assertExists()
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_phase_match))
            .assertExists()
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_save))
            .assertExists()
    }

    @Test
    fun completedStateShowsDoneAndCopiesMetrics() {
        val preview = Bitmap.createBitmap(100, 50, Bitmap.Config.ARGB_8888)
        val tileBitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        val rawMetrics = """{"runs":[{"run_id":1}]}"""
        composeTestRule.setContent {
            EditorScreen(
                state =
                    EditorUiState(
                        coreVersion = "v",
                        screen = EditorStage.Edit,
                        mainImage = MainImageUi(preview, 100, 50, scaled = false),
                        tiles = listOf(TileUi(1L, tileBitmap)),
                        grid = GridInfo(100, 50, 24, 5, 3, 15),
                        preview = preview,
                        progress = GenerationProgressUi("done", 1f, 1f, 15, 15),
                        metrics = MetricsUi("[metrics #1] trigger: initial", rawMetrics),
                        resultReady = true,
                        config =
                            dev.keiji.photomasaic.core
                                .MosaicConfig(),
                    ),
                actions = EditorActions(),
            )
        }
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_phase_done))
            .assertExists()
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_metrics_title))
            .assertExists()
        composeTestRule
            .onNodeWithText("[metrics #1] trigger: initial")
            .assertExists()
        composeTestRule
            .onNodeWithContentDescription(composeTestRule.activity.getString(R.string.editor_metrics_copy))
            .performScrollTo()
            .performClick()
        val clipboard = composeTestRule.activity.getSystemService(ClipboardManager::class.java)
        org.junit.Assert.assertEquals(rawMetrics, clipboard.primaryClip?.getItemAt(0)?.text)
    }
}
