package dev.keiji.photomasaic.quality

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.keiji.photomasaic.MainActivity
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/** 回転・Activity 再生成でアプリが破綻しないこと(A3)を確認する。 */
@RunWith(AndroidJUnit4::class)
class MainActivityRecreateTest {
    @Test
    fun recreationKeepsActivityAlive() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.recreate()
            scenario.onActivity { activity -> assertFalse(activity.isFinishing) }
        }
    }
}
