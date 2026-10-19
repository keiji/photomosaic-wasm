package dev.keiji.photomasaic.ui.editor

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.keiji.photomasaic.R
import dev.keiji.photomasaic.io.MAIN_MAX_EDGE

/** タイル一覧の初期表示枚数(基本設計書 2.2) */
private const val TILE_PREVIEW_LIMIT = 20

/** 1 回の Photo Picker で選択できる構成画像の上限(基本設計書 2.2) */
internal const val MAX_TILES_PER_PICK = 100

@Composable
internal fun MainImageCard(
    main: MainImageUi?,
    onSelect: () -> Unit,
) {
    OutlinedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (main == null) {
                EmptyMainImage()
                Button(onClick = onSelect, modifier = Modifier.fillMaxWidth()) {
                    Text(text = stringResource(R.string.editor_main_image_select))
                }
            } else {
                MainImagePreview(main)
                MainImageMeta(main)
                OutlinedButton(onClick = onSelect, modifier = Modifier.fillMaxWidth()) {
                    Text(text = stringResource(R.string.editor_main_image_change))
                }
            }
        }
    }
}

@Composable
private fun EmptyMainImage() {
    Box(
        modifier = Modifier.fillMaxWidth().height(120.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.editor_main_image_empty),
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun MainImagePreview(main: MainImageUi) {
    Box(
        modifier = Modifier.fillMaxWidth().height(200.dp),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            bitmap = main.bitmap.asImageBitmap(),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Fit,
        )
    }
}

@Composable
private fun MainImageMeta(main: MainImageUi) {
    Text(
        text = stringResource(R.string.editor_image_size, main.width, main.height),
        style = MaterialTheme.typography.bodySmall,
    )
    if (main.scaled) {
        Text(
            text = stringResource(R.string.editor_image_scaled, MAIN_MAX_EDGE),
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
internal fun TilesCard(
    state: EditorUiState,
    showAllTiles: Boolean,
    onShowAllTiles: () -> Unit,
    onAddTiles: () -> Unit,
    onRemoveTile: (Long) -> Unit,
) {
    OutlinedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (state.tiles.isEmpty()) {
                EmptyTiles()
            } else {
                TileList(
                    tiles = state.tiles,
                    showAllTiles = showAllTiles,
                    onShowAllTiles = onShowAllTiles,
                    onRemoveTile = onRemoveTile,
                )
            }
            state.loading?.let { TilesLoading(it) }
            if (state.tilesLimitReached) {
                Text(
                    text = stringResource(R.string.editor_tiles_limit_reached, MAX_TILES_PER_PICK),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
            Button(
                onClick = onAddTiles,
                enabled = state.loading == null,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(text = stringResource(R.string.editor_tiles_add))
            }
        }
    }
}

@Composable
private fun EmptyTiles() {
    Box(
        modifier = Modifier.fillMaxWidth().height(120.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.editor_tiles_empty),
            textAlign = TextAlign.Center,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TileList(
    tiles: List<TileUi>,
    showAllTiles: Boolean,
    onShowAllTiles: () -> Unit,
    onRemoveTile: (Long) -> Unit,
) {
    Text(
        text = stringResource(R.string.editor_tiles_count, tiles.size),
        style = MaterialTheme.typography.bodySmall,
    )
    val visibleTiles = if (showAllTiles) tiles else tiles.take(TILE_PREVIEW_LIMIT)
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        visibleTiles.forEach { tile ->
            TileThumb(tile = tile, onRemove = onRemoveTile)
        }
    }
    if (!showAllTiles && tiles.size > TILE_PREVIEW_LIMIT) {
        TextButton(onClick = onShowAllTiles) {
            Text(text = stringResource(R.string.editor_tiles_show_all, tiles.size))
        }
    }
}

@Composable
private fun TilesLoading(loading: EditorUiState.Loading) {
    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
    Text(
        text = stringResource(R.string.editor_tiles_loading, loading.processed, loading.total),
        style = MaterialTheme.typography.bodySmall,
    )
}

@Composable
private fun TileThumb(
    tile: TileUi,
    onRemove: (Long) -> Unit,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Image(
            bitmap = tile.bitmap.asImageBitmap(),
            contentDescription = null,
            modifier =
                Modifier
                    .size(72.dp)
                    .clip(RoundedCornerShape(8.dp)),
            contentScale = ContentScale.Crop,
        )
        TextButton(
            onClick = { onRemove(tile.id) },
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
        ) {
            Text(text = stringResource(R.string.editor_tile_remove))
        }
    }
}
