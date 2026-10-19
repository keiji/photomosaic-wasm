package dev.keiji.photomasaic.ui.startup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.keiji.photomasaic.R
import dev.keiji.photomasaic.theme.PhotomosaicTheme

/** ViewModel と画面を結線するルート(A0)。 */
@Composable
fun StartupRoute(
    modifier: Modifier = Modifier,
    viewModel: StartupViewModel = viewModel(factory = StartupViewModel.factory(LocalContext.current)),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    StartupScreen(state = state, onRetry = viewModel::check, modifier = modifier)
}

/**
 * A0 起動画面。サンドボックス対応・WebAssembly 対応・コアバージョンを表示する。
 * 非対応端末では案内文言を表示する(handoff/06 §2)。
 */
@Composable
fun StartupScreen(
    state: StartupUiState,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall)
        Text(
            text = stringResource(R.string.privacy_notice),
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center,
        )
        when (state) {
            StartupUiState.Checking -> {
                CircularProgressIndicator()
                Text(text = stringResource(R.string.startup_checking))
            }
            is StartupUiState.Ready -> {
                StatusRow(stringResource(R.string.startup_sandbox_ok))
                StatusRow(stringResource(R.string.startup_wasm_ok))
                StatusRow(stringResource(R.string.startup_core_version, state.coreVersion))
            }
            StartupUiState.SandboxUnsupported -> {
                Text(
                    text = stringResource(R.string.startup_sandbox_unsupported),
                    textAlign = TextAlign.Center,
                )
            }
            StartupUiState.WebAssemblyUnavailable -> {
                Text(
                    text = stringResource(R.string.startup_wasm_unavailable),
                    textAlign = TextAlign.Center,
                )
            }
            is StartupUiState.Failed -> {
                Text(
                    text = stringResource(R.string.startup_failed),
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = state.message,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                )
                Button(onClick = onRetry) { Text(text = stringResource(R.string.retry)) }
            }
        }
    }
}

@Composable
private fun StatusRow(text: String) {
    Text(text = text, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
}

@Preview(showBackground = true)
@Composable
internal fun StartupReadyPreview() {
    PhotomosaicTheme {
        StartupScreen(state = StartupUiState.Ready("photomosaic-core 0.1.0"), onRetry = {})
    }
}

@Preview(showBackground = true)
@Composable
internal fun StartupUnsupportedPreview() {
    PhotomosaicTheme { StartupScreen(state = StartupUiState.SandboxUnsupported, onRetry = {}) }
}
