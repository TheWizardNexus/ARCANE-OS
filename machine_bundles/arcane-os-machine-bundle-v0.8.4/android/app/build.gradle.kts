plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val stageArcaneAndroidAssets by tasks.registering(Sync::class) {
    dependsOn(rootProject.tasks.named("buildArcaneAndroidDistributionAssets"))
    from("../../dist/android-build-assets/launcher")
    into(layout.buildDirectory.dir("generated/arcaneAndroidAssets"))
}

android {
    namespace = "os.arcane.host.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "os.arcane.host.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 804
        versionName = "0.8.4"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    sourceSets {
        getByName("main") {
            java.srcDir("../../src/hosts/android")
            assets.srcDir("../../dist/app")
            assets.srcDir(stageArcaneAndroidAssets)
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isDebuggable = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        allWarningsAsErrors = true
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

tasks.named("preBuild") {
    dependsOn(rootProject.tasks.named("buildArcaneCoreAssets"))
    dependsOn(stageArcaneAndroidAssets)
}

dependencies {
    implementation("androidx.annotation:annotation:1.9.1")
    implementation("androidx.webkit:webkit:1.16.0")

    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit-ktx:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
