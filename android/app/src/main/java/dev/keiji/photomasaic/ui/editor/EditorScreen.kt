package dev.keiji.photomasaic.ui.editor

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.keiji.photomasaic.R

/** ViewModel と S1 開始画面を結線するルート(A1)。 */
@Composable
fun EditorRoute(
    coreVersion: String,
    modifier: Modifier = Modifier,
    viewModel: EditorViewModel =
        viewModel(factory = EditorViewModel.factory(LocalContext.current, coreVersion)),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    EditorScreen(
        state = state,
        onMainImageSelected = viewModel::setMainImage,
        onTilesSelected = viewModel::addTiles,
        onRemoveTile = viewModel::removeTile,
        modifier = modifier,
    )
}

/**
 * S1 開始画面(A1)。メイン画像 1 枚と構成画像(複数)を Photo Picker で選択し、
 * 端末内でデコード・正規化した結果をプレビュー表示する。
 */
@Composable
fun EditorScreen(
    state: EditorUiState,
    onMainImageSelected: (Uri) -> Unit,
    onTilesSelected: (List<Uri>) -> Unit,
    onRemoveTile: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val mainPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            uri?.let(onMainImageSelected)
        }
    val tilesPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
            onTilesSelected(uris)
        }
    val imageOnly = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
    var showAllTiles by rememberSaveable { mutableStateOf(false) }

    Column(
        modifier =
            modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        EditorHeader()
        PrivacyNotice()
        SectionTitle(stringResource(R.string.editor_main_image_title))
        MainImageCard(
            main = state.mainImage,
            onSelect = { mainPicker.launch(imageOnly) },
        )
        SectionTitle(stringResource(R.string.editor_tiles_title))
        TilesCard(
            state = state,
            showAllTiles = showAllTiles,
            onShowAllTiles = { showAllTiles = true },
            onAddTiles = { tilesPicker.launch(imageOnly) },
            onRemoveTile = onRemoveTile,
        )
        state.error?.let { DecodeErrorText() }
        CoreVersionText(state.coreVersion)
    }
}

@Composable
private fun EditorHeader() {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.weight(1f),
        )
        Surface(
            color = MaterialTheme.colorScheme.secondaryContainer,
            shape = CircleShape,
        ) {
            Text(
                text = stringResource(R.string.editor_offline),
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

@Composable
private fun PrivacyNotice() {
    Text(
        text = stringResource(R.string.privacy_notice),
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun SectionTitle(text: String) {
    Text(text = text, style = MaterialTheme.typography.titleMedium)
}

@Composable
private fun DecodeErrorText() {
    Text(
        text = stringResource(R.string.editor_decode_failed),
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun CoreVersionText(coreVersion: String) {
    Text(
        text = stringResource(R.string.editor_core_version, coreVersion),
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.fillMaxWidth(),
    )
}
