import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.detekt)
}

// --- コア資産の生成先(handoff/06 §4.3) ---
// サンドボックス用コア資産(グルー + .wasm)は Gradle タスクで生成し、
// 生成物を assets として取り込む(Web と同一の .wasm を使う)。
val coreGlueDir = layout.buildDirectory.dir("core-glue")
val coreAssetsDir = layout.buildDirectory.dir("generated/coreAssets")

/** 生成済みグルーから必要な 2 ファイルだけを assets 用ディレクトリへ複製する */
abstract class SyncCoreAssets : DefaultTask() {
    @get:InputDirectory abstract val glueDir: DirectoryProperty

    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun sync() {
        val source = glueDir.get().asFile
        val target = outputDir.get().asFile.resolve("core")
        target.deleteRecursively()
        target.mkdirs()
        for (name in CORE_ASSET_FILES) {
            source.resolve(name).copyTo(target.resolve(name), overwrite = true)
        }
    }

    private companion object {
        val CORE_ASSET_FILES = listOf("photomosaic_core_wasm.js", "photomosaic_core_wasm_bg.wasm")
    }
}

android {
    namespace = "dev.keiji.photomasaic"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.keiji.photomasaic"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = false
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    jvmToolchain(21)
}

// wasm-pack の no-modules ターゲットは ES モジュール非依存のグルーを生成し、
// AndroidX JavaScriptEngine の isolate(evaluateJavaScriptAsync)で評価できる。
// .wasm 本体は Web と同一で、グルーだけがサンドボックス向けになる。
val buildCoreGlue by tasks.registering(Exec::class) {
    group = "build"
    description = "Build the no-modules WASM glue for the Android sandbox"
    val repoRoot = rootProject.projectDir.parentFile
    workingDir = repoRoot
    commandLine(
        "wasm-pack",
        "build",
        "core-wasm",
        "--release",
        "--target",
        "no-modules",
        "--out-dir",
        coreGlueDir.get().asFile.absolutePath,
        "--out-name",
        "photomosaic_core_wasm",
    )
    inputs.files(
        fileTree(repoRoot.resolve("core")) {
            include("src/**/*.rs", "Cargo.toml", "Cargo.lock")
        },
        repoRoot.resolve("core-wasm/src/lib.rs"),
        repoRoot.resolve("core-wasm/Cargo.toml"),
        repoRoot.resolve("rust-toolchain.toml"),
    )
    outputs.dir(coreGlueDir)
}

val syncCoreAssets by tasks.registering(SyncCoreAssets::class) {
    group = "build"
    description = "Copy the sandbox core assets (glue + wasm) into generated assets"
    dependsOn(buildCoreGlue)
    glueDir.set(coreGlueDir)
    outputDir.set(coreAssetsDir)
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(syncCoreAssets, SyncCoreAssets::outputDir)
    }
}

detekt {
    buildUponDefaultConfig = true
    config.setFrom(rootProject.file("config/detekt/detekt.yml"))
    parallel = true
}

dependencies {
    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    androidTestImplementation(composeBom)

    // Core Android dependencies
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)

    // Arch Components
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    // Compose
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // AndroidX JavaScript Engine(サンドボックス上で Web と同一の WASM を実行)
    implementation(libs.androidx.javascriptengine)

    // EXIF 回転の反映(API 26〜27 の BitmapFactory 経路で使用)
    implementation(libs.androidx.exifinterface)

    // Local tests
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    // Instrumented tests
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}
