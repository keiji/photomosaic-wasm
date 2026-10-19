package dev.keiji.photomasaic.ui.startup

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.keiji.photomasaic.R
import org.junit.Rule
import org.junit.Test

/** A0 起動画面の表示内容(コアバージョン・非対応案内)を検証する。 */
class StartupScreenTest {
    @get:Rule val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun readyStateShowsCoreVersion() {
        val version = "photomosaic-core 0.1.0"
        val expected = composeTestRule.activity.getString(R.string.startup_core_version, version)
        composeTestRule.setContent { StartupScreen(StartupUiState.Ready(version), onRetry = {}) }
        composeTestRule.onNodeWithText(expected).assertExists()
    }

    @Test
    fun unsupportedStateShowsGuidance() {
        val expected = composeTestRule.activity.getString(R.string.startup_sandbox_unsupported)
        composeTestRule.setContent { StartupScreen(StartupUiState.SandboxUnsupported, onRetry = {}) }
        composeTestRule.onNodeWithText(expected).assertExists()
    }
}
