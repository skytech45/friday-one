import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

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
    compileSdk = 34

    defaultConfig {
        applicationId = "com.friday.one"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // The console host is injected at build time so the APK is not tied to
        // one tunnel URL. Override with -PFRIDAY_BASE_URL=https://...
        val baseUrl = (project.findProperty("FRIDAY_BASE_URL") as String?)
            ?: "http://127.0.0.1:8788"
        buildConfigField("String", "BASE_URL", "\"$baseUrl\"")
        // Phase 1-4 cloud stack. The publishable key is public by design; the
        // gateway URL churns with the quick tunnel until the named tunnel lands.
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
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.8.3")

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.jakewharton.retrofit:retrofit2-kotlinx-serialization-converter:1.0.0")

    implementation("androidx.datastore:datastore-preferences:1.1.1")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.biometric:biometric:1.1.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
