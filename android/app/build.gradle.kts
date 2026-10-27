import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.gms.google-services")
}

// Firebase client config is per variant and git-ignored:
// src/debug/google-services.json (dev project, com.friday.one.debug) and
// src/release/google-services.json. A variant without one still builds, with
// Firebase unconfigured (CI, fresh clones); sign-in then reports that clearly.
googleServices {
    missingGoogleServicesStrategy = com.google.gms.googleservices.GoogleServicesPlugin.MissingGoogleServicesStrategy.WARN
}

/** Gradle property with a default, e.g. -PAUTH_PROVIDER=firebase. */
fun prop(name: String, default: String): String = (project.findProperty(name) as String?) ?: default

// F-14: release signing comes from a keystore OUTSIDE the repo. The build
// machine keeps ~/.android-keys/key.properties (0600) pointing at the .jks;
// if the file is absent the release build falls back to the debug key so a
// cold checkout still builds — CI must assert the real certificate instead.
val keystoreProperties = Properties().apply {
    val f = File(System.getProperty("user.home"), ".android-keys/key.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.friday.one"
    // 35 is required by Credential Manager / Firebase Auth's AndroidX deps.
    // targetSdk stays 34, so runtime behaviour on devices does not change.
    compileSdk = 35

    defaultConfig {
        applicationId = "com.friday.one"
        minSdk = 26
        targetSdk = 34
        versionCode = 10
        versionName = "0.9.0"
        // v2 cloud stack. Publishable key is public by design; authorization
        // is server-side (RLS + control-plane verification).
        val supabaseUrl = (project.findProperty("SUPABASE_URL") as String?)
            ?: "https://tbysxnyuipjwutqxtxvy.supabase.co"
        val supabaseKey = (project.findProperty("SUPABASE_PUBLISHABLE_KEY") as String?)
            ?: "sb_publishable_cbDZTC7O2OVsHpolFzqL1w_zcshNmMP"
        val controlPlaneUrl = (project.findProperty("CONTROL_PLANE_URL") as String?)
            ?: "https://friday-one-control-plane-cotts1-2550.vercel.app"
        val gatewayUrl = (project.findProperty("GATEWAY_URL") as String?)
            ?: "wss://rugs-ada-legislature-literacy.trycloudflare.com"
        buildConfigField("String", "SUPABASE_URL", "\"$supabaseUrl\"")
        buildConfigField("String", "SUPABASE_PUBLISHABLE_KEY", "\"$supabaseKey\"")
        buildConfigField("String", "CONTROL_PLANE_URL", "\"$controlPlaneUrl\"")
        buildConfigField("String", "GATEWAY_URL", "\"$gatewayUrl\"")
        // Auth backend (Firebase migration): "supabase" = legacy stack,
        // "firebase" = Firebase Auth + Cloud Functions + Cloud Run gateway.
        buildConfigField("String", "AUTH_PROVIDER", "\"${prop("AUTH_PROVIDER", "supabase")}\"")
    }

    signingConfigs {
        if (keystoreProperties.isNotEmpty()) {
            create("release") {
                storeFile = File(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            // Debug builds run against the Firebase dev project (decision D1).
            // Release stays on the legacy stack until cutover (plan §4).
            // GATEWAY_URL empty = discover it from /api/v1/health.
            buildConfigField("String", "AUTH_PROVIDER", "\"${prop("AUTH_PROVIDER", "firebase")}\"")
            buildConfigField(
                "String", "CONTROL_PLANE_URL",
                "\"${prop("FIREBASE_API_URL", "https://asia-south1-friday-969ea.cloudfunctions.net/api")}\"",
            )
            buildConfigField("String", "GATEWAY_URL", "\"${prop("FIREBASE_GATEWAY_URL", "")}\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keystoreProperties.isNotEmpty()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
    testOptions {
        // Robolectric-backed Compose smoke tests need merged resources.
        unitTests.isIncludeAndroidResources = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // QR pairing scan (plan v2 §10) — zxing embedded handles camera+decode.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.zxing:core:3.5.3")

    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Firebase Auth + Google sign-in through Credential Manager (migration plan §2.6).
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
    implementation("com.google.firebase:firebase-auth")
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.8.1")

    testImplementation("junit:junit:4.13.2")
    // Compose screen smoke tests on the JVM (no emulator): Robolectric host.
    testImplementation(composeBom)
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("org.robolectric:robolectric:4.13")
    // Real WebSocket server for GatewayClient reconnect tests.
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
