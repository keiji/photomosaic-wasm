@file:Suppress("LongMethod", "LongParameterList", "TooManyFunctions")

package dev.keiji.photomasaic.ui.editor

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.keiji.photomasaic.R
import dev.keiji.photomasaic.core.CoreEngine
import dev.keiji.photomasaic.core.MosaicConfig
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.roundToInt

/** ViewModel と画面を結線するルート(A1/A2)。 */
@Composable
fun EditorRoute(
    coreVersion: String,
    core: CoreEngine,
    modifier: Modifier = Modifier,
    viewModel: EditorViewModel =
        viewModel(factory = EditorViewModel.factory(LocalContext.current, coreVersion, core)),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    EditorScreen(
        state = state,
        actions =
            EditorActions(
                onMainImageSelected = viewModel::setMainImage,
                onTilesSelected = viewModel::addTiles,
                onRemoveTile = viewModel::removeTile,
                onStartEdit = viewModel::enterEdit,
                onBack = viewModel::reset,
                onBlockSizeDraft = viewModel::setBlockSizeDraft,
                onBlockSizeCommit = viewModel::commitBlockSize,
                onMainBlendDraft = viewModel::setMainBlend,
                onColorCorrectDraft = viewModel::setColorCorrect,
                onDuplicateDeDraft = viewModel::setDuplicateDe,
                onConfigCommit = viewModel::commitConfig,
                onCancel = viewModel::cancelGeneration,
                onSave = viewModel::save,
                onShare = viewModel::share,
                onShareHandled = viewModel::shareHandled,
                onToggleProgress = viewModel::toggleProgress,
                onStoragePermissionDenied = viewModel::storagePermissionDenied,
                onDismissNotice = viewModel::dismissNotice,
            ),
        modifier = modifier,
    )
}

/**
 * S1 開始画面(A1)と S2 編集画面(A2)。
 * S1 でメイン画像・構成画像を選択して編集を開始し、S2 で生成・進捗・保存を行う。
 */
@Composable
fun EditorScreen(
    state: EditorUiState,
    actions: EditorActions,
    modifier: Modifier = Modifier,
) {
    val mainPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            uri?.let(actions.onMainImageSelected)
        }
    val tilesPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
            actions.onTilesSelected(uris)
        }
    val imageOnly = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
    var showAllTiles by rememberSaveable { mutableStateOf(false) }

    if (state.screen == EditorStage.Start) {
        StartContent(
            state = state,
            showAllTiles = showAllTiles,
            onShowAllTiles = { showAllTiles = true },
            onSelectMain = { mainPicker.launch(imageOnly) },
            onAddTiles = { tilesPicker.launch(imageOnly) },
            actions = actions,
            modifier = modifier,
        )
    } else {
        EditContent(
            state = state,
            showAllTiles = showAllTiles,
            onShowAllTiles = { showAllTiles = true },
            onSelectMain = { mainPicker.launch(imageOnly) },
            onAddTiles = { tilesPicker.launch(imageOnly) },
            actions = actions,
            modifier = modifier,
        )
    }
}

@Composable
private fun StartContent(
    state: EditorUiState,
    showAllTiles: Boolean,
    onShowAllTiles: () -> Unit,
    onSelectMain: () -> Unit,
    onAddTiles: () -> Unit,
    actions: EditorActions,
    modifier: Modifier,
) {
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
            onSelect = onSelectMain,
        )
        SectionTitle(stringResource(R.string.editor_tiles_title))
        TilesCard(
            state = state,
            showAllTiles = showAllTiles,
            onShowAllTiles = onShowAllTiles,
            onAddTiles = onAddTiles,
            onRemoveTile = actions.onRemoveTile,
        )
        state.error?.let { ErrorText(it) }
        Button(
            onClick = actions.onStartEdit,
            enabled = state.mainImage != null,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(text = stringResource(R.string.editor_start_edit))
        }
        CoreVersionText(state.coreVersion)
    }
}

@Composable
private fun EditContent(
    state: EditorUiState,
    showAllTiles: Boolean,
    onShowAllTiles: () -> Unit,
    onSelectMain: () -> Unit,
    onAddTiles: () -> Unit,
    actions: EditorActions,
    modifier: Modifier,
) {
    val context = LocalContext.current
    val permissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                actions.onSave()
            } else {
                actions.onStoragePermissionDenied()
            }
        }
    val saveWithPermission = {
        val legacy = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
        val granted =
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
            ) == PackageManager.PERMISSION_GRANTED
        if (legacy && !granted) {
            permissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        } else {
            actions.onSave()
        }
    }

    val chooserTitle = stringResource(R.string.share_chooser_title)
    LaunchedEffect(state.shareIntent) {
        state.shareIntent?.let { intent ->
            val chooser = Intent.createChooser(intent, chooserTitle)
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(chooser)
            actions.onShareHandled()
        }
    }

    Column(
        modifier =
            modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        EditToolbar(
            canSave = state.resultReady && !state.saving,
            saving = state.saving,
            onBack = actions.onBack,
            onSave = saveWithPermission,
        )
        PreviewCard(
            state = state,
            onChangeMainImage = onSelectMain,
        )
        BlockSizeControl(state = state, actions = actions)
        state.config?.let { config ->
            ConfigControls(config = config, actions = actions)
        }
        ProgressPanel(state = state, actions = actions)
        state.metrics?.let { MetricsPanel(it) }
        TilesCard(
            state = state,
            showAllTiles = showAllTiles,
            onShowAllTiles = onShowAllTiles,
            onAddTiles = onAddTiles,
            onRemoveTile = actions.onRemoveTile,
        )
        if (state.tiles.isEmpty()) {
            Text(
                text = stringResource(R.string.editor_tiles_required),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        ResultActions(
            canUseResult = state.resultReady,
            onShare = actions.onShare,
        )
        state.error?.let { ErrorText(it) }
        state.notice?.let { NoticeText(it) }
        CoreVersionText(state.coreVersion)
    }
}

@Composable
private fun EditToolbar(
    canSave: Boolean,
    saving: Boolean,
    onBack: () -> Unit,
    onSave: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack) {
            Text(text = stringResource(R.string.editor_back))
        }
        Text(
            text = stringResource(R.string.editor_title),
            style = MaterialTheme.typography.titleMedium,
        )
        Button(onClick = onSave, enabled = canSave) {
            Text(
                text =
                    if (saving) {
                        stringResource(R.string.editor_saving)
                    } else {
                        stringResource(R.string.editor_save)
                    },
            )
        }
    }
}

@Composable
private fun PreviewCard(
    state: EditorUiState,
    onChangeMainImage: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .height(240.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(onClick = onChangeMainImage),
            contentAlignment = Alignment.Center,
        ) {
            val preview = state.preview
            if (preview != null) {
                Image(
                    bitmap = preview.asImageBitmap(),
                    contentDescription = stringResource(R.string.editor_preview_change),
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Fit,
                )
            } else {
                Text(text = stringResource(R.string.editor_preview_empty))
            }
        }
        Text(
            text = stringResource(R.string.editor_preview_hint),
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun BlockSizeControl(
    state: EditorUiState,
    actions: EditorActions,
) {
    LabeledSlider(
        label = stringResource(R.string.editor_block_size_label),
        valueText = stringResource(R.string.editor_block_size_value, state.blockSize),
        value = state.blockSize.toFloat(),
        valueRange = MIN_BLOCK_SIZE.toFloat()..MAX_BLOCK_SIZE.toFloat(),
        steps = MAX_BLOCK_SIZE - MIN_BLOCK_SIZE - 1,
        onDraft = { actions.onBlockSizeDraft(it.roundToInt()) },
        onCommit = { actions.onBlockSizeCommit(it.roundToInt()) },
    )
}

@Composable
private fun ConfigControls(
    config: MosaicConfig,
    actions: EditorActions,
) {
    LabeledSlider(
        label = stringResource(R.string.editor_main_blend_label),
        valueText = null,
        value = config.mainBlend,
        valueRange = 0f..MAX_MAIN_BLEND,
        steps = 0,
        onDraft = actions.onMainBlendDraft,
        onCommit = { actions.onConfigCommit() },
    )
    LabeledSlider(
        label = stringResource(R.string.editor_color_correct_label),
        valueText = null,
        value = config.colorCorrect,
        valueRange = 0f..1f,
        steps = 0,
        onDraft = actions.onColorCorrectDraft,
        onCommit = { actions.onConfigCommit() },
    )
    LabeledSlider(
        label = stringResource(R.string.editor_duplicate_de_label),
        valueText = null,
        value = config.duplicateDe,
        valueRange = MIN_DUPLICATE_DE..MAX_DUPLICATE_DE,
        steps = 0,
        onDraft = actions.onDuplicateDeDraft,
        onCommit = { actions.onConfigCommit() },
    )
}

@Composable
private fun LabeledSlider(
    label: String,
    valueText: String?,
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    steps: Int,
    onDraft: (Float) -> Unit,
    onCommit: (Float) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(text = label, style = MaterialTheme.typography.bodyMedium)
            valueText?.let {
                Text(text = it, style = MaterialTheme.typography.bodySmall)
            }
        }
        Slider(
            value = value,
            onValueChange = onDraft,
            onValueChangeFinished = { onCommit(value) },
            valueRange = valueRange,
            steps = steps,
        )
    }
}

@Composable
private fun ProgressPanel(
    state: EditorUiState,
    actions: EditorActions,
) {
    val progress = state.progress ?: return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.editor_progress_title),
                style = MaterialTheme.typography.titleSmall,
            )
            TextButton(onClick = actions.onToggleProgress) {
                Text(
                    text =
                        if (state.progressExpanded) {
                            stringResource(R.string.editor_progress_hide)
                        } else {
                            stringResource(R.string.editor_progress_show)
                        },
                )
            }
        }
        if (state.progressExpanded) {
            val fraction =
                if (progress.totalBlocks > 0) {
                    (progress.assignedBlocks.toFloat() / progress.totalBlocks).coerceIn(0f, 1f)
                } else {
                    0f
                }
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                text =
                    stringResource(
                        R.string.editor_blocks_label,
                        formatCount(progress.assignedBlocks),
                        formatCount(progress.totalBlocks),
                        (fraction * PERCENT).roundToInt(),
                    ),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                text = phaseLabel(progress.phaseCode),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (state.generating) {
            OutlinedButton(onClick = actions.onCancel, modifier = Modifier.fillMaxWidth()) {
                Text(text = stringResource(R.string.editor_cancel))
            }
        }
    }
}

@Composable
private fun MetricsPanel(metrics: MetricsUi) {
    val context = LocalContext.current
    val copyLabel = stringResource(R.string.editor_metrics_copy)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = stringResource(R.string.editor_metrics_title),
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                text = metrics.summary.ifEmpty { stringResource(R.string.editor_metrics_empty) },
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
            )
        }
        IconButton(
            onClick = {
                val clipboard = context.getSystemService(ClipboardManager::class.java)
                clipboard?.setPrimaryClip(ClipData.newPlainText("metrics", metrics.rawJson))
            },
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_content_copy),
                contentDescription = copyLabel,
            )
        }
    }
}

@Composable
private fun ResultActions(
    canUseResult: Boolean,
    onShare: () -> Unit,
) {
    OutlinedButton(
        onClick = onShare,
        enabled = canUseResult,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(text = stringResource(R.string.editor_share))
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
private fun ErrorText(error: EditorError) {
    Text(
        text =
            when (error) {
                EditorError.DecodeFailed -> stringResource(R.string.editor_decode_failed)
                EditorError.CoreFailed -> stringResource(R.string.editor_core_failed)
            },
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun NoticeText(notice: EditorNotice) {
    val text =
        when (notice) {
            EditorNotice.GenerationFailed -> stringResource(R.string.editor_generation_failed)
            EditorNotice.Canceled -> stringResource(R.string.editor_generation_canceled)
            EditorNotice.SaveSucceeded -> stringResource(R.string.editor_save_succeeded)
            EditorNotice.SaveFailed -> stringResource(R.string.editor_save_failed)
            EditorNotice.ShareFailed -> stringResource(R.string.editor_share_failed)
            EditorNotice.StoragePermissionDenied ->
                stringResource(R.string.editor_storage_permission_denied)
        }
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color =
            if (notice == EditorNotice.SaveSucceeded) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.error
            },
    )
}

@Composable
private fun phaseLabel(code: String): String =
    when (code) {
        "main_analyze" -> stringResource(R.string.editor_phase_main_analyze)
        "tile_analyze" -> stringResource(R.string.editor_phase_tile_analyze)
        "match" -> stringResource(R.string.editor_phase_match)
        "compose" -> stringResource(R.string.editor_phase_compose)
        "done" -> stringResource(R.string.editor_phase_done)
        else -> code
    }

@Composable
private fun CoreVersionText(coreVersion: String) {
    Text(
        text = stringResource(R.string.editor_core_version, coreVersion),
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.fillMaxWidth(),
    )
}

private fun formatCount(value: Int): String = NumberFormat.getIntegerInstance(Locale.US).format(value)

private const val MIN_BLOCK_SIZE = 8
private const val MAX_BLOCK_SIZE = 128
private const val MAX_MAIN_BLEND = 0.8f
private const val MIN_DUPLICATE_DE = 0.5f
private const val MAX_DUPLICATE_DE = 8.0f
private const val PERCENT = 100f
