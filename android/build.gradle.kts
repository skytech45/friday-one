plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
    id("com.google.devtools.ksp") version "2.0.21-1.0.28" apply false
    // Firebase (migration plan §2.6). Applied to :app in the auth phase, once
    // per-variant google-services.json files exist for debug and release.
    id("com.google.gms.google-services") version "4.5.0" apply false
}
