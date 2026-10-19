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
import dev.keiji.photomasaic.theme.PhotomosaicTheme
import dev.keiji.photomasaic.ui.editor.EditorRoute
import dev.keiji.photomasaic.ui.startup.StartupRoute

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            PhotomosaicTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    var coreVersion by remember { mutableStateOf<String?>(null) }
                    val readyVersion = coreVersion
                    if (readyVersion == null) {
                        StartupRoute(
                            modifier = Modifier.safeDrawingPadding(),
                            onReady = { coreVersion = it },
                        )
                    } else {
                        EditorRoute(
                            coreVersion = readyVersion,
                            modifier = Modifier.safeDrawingPadding(),
                        )
                    }
                }
            }
        }
    }
}
