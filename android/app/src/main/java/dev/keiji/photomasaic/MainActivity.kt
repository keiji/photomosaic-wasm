package dev.keiji.photomasaic

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.keiji.photomasaic.theme.PhotomosaicTheme
import dev.keiji.photomasaic.ui.editor.EditorRoute
import dev.keiji.photomasaic.ui.startup.StartupRoute
import dev.keiji.photomasaic.ui.startup.StartupViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            PhotomosaicTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    // 起動検査と編集画面で同一のコア(サンドボックス)を共有する。
                    // ViewModel は Activity の ViewModelStore に保持され、回転後も維持される。
                    val startupViewModel: StartupViewModel =
                        viewModel(factory = StartupViewModel.factory(LocalContext.current))
                    var coreVersion by remember { mutableStateOf<String?>(null) }
                    val readyVersion = coreVersion
                    if (readyVersion == null) {
                        StartupRoute(
                            modifier = Modifier.safeDrawingPadding(),
                            onReady = { coreVersion = it },
                            viewModel = startupViewModel,
                        )
                    } else {
                        EditorRoute(
                            coreVersion = readyVersion,
                            core = startupViewModel.engine,
                            modifier = Modifier.safeDrawingPadding(),
                        )
                    }
                }
            }
        }
    }
}
