package dev.keiji.photomasaic.ui.editor

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import dev.keiji.photomasaic.theme.PhotomosaicTheme

@Preview(showBackground = true)
@Composable
internal fun EditorEmptyPreview() {
    PhotomosaicTheme {
        EditorScreen(
            state = EditorUiState(coreVersion = "photomosaic-core 0.1.0"),
            onMainImageSelected = {},
            onTilesSelected = {},
            onRemoveTile = {},
        )
    }
}
