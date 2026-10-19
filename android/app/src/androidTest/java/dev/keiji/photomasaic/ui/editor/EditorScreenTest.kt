@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.ui.editor

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.keiji.photomasaic.R
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** S1 開始画面の表示内容テスト(A1)。 */
@RunWith(AndroidJUnit4::class)
class EditorScreenTest {
    @get:Rule val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun emptyStateShowsPickerButtons() {
        composeTestRule.setContent {
            EditorScreen(
                state = EditorUiState(coreVersion = "v"),
                onMainImageSelected = {},
                onTilesSelected = {},
                onRemoveTile = {},
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
                onMainImageSelected = {},
                onTilesSelected = {},
                onRemoveTile = {},
            )
        }
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_image_size, 100, 50))
            .assertExists()
        composeTestRule
            .onNodeWithText(composeTestRule.activity.getString(R.string.editor_tiles_count, 1))
            .assertExists()
    }
}
