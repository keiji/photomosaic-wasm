package dev.keiji.photomasaic.ui.editor

import android.content.Context

/** 進捗表示領域の開閉状態を保持する(基本設計書 2.3)。 */
interface ProgressPreferences {
    fun isExpanded(): Boolean

    fun setExpanded(expanded: Boolean)
}

/** Android のユーザー設定は SharedPreferences に保存する。 */
class SharedPreferencesProgressPreferences(
    context: Context,
) : ProgressPreferences {
    private val preferences =
        context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun isExpanded(): Boolean = preferences.getBoolean(KEY_EXPANDED, DEFAULT_EXPANDED)

    override fun setExpanded(expanded: Boolean) {
        preferences.edit().putBoolean(KEY_EXPANDED, expanded).apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "editor_preferences"
        const val KEY_EXPANDED = "progress_expanded"
        const val DEFAULT_EXPANDED = true
    }
}
