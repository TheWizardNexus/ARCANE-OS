plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val arcaneNodeExecutable = providers.gradleProperty("arcaneNodeExecutable").getOrElse("node")

val buildArcaneCoreAssets by tasks.registering(Exec::class) {
    workingDir("../..")
    commandLine(
        arcaneNodeExecutable,
        "tools/build-core.mjs"
    )
}

val buildArcanePortableApps by tasks.registering(Exec::class) {
    outputs.upToDateWhen { false }
    workingDir("../..")
    commandLine(
        arcaneNodeExecutable,
        "tools/build-app.mjs",
        "--all",
        "--platform=portable"
    )
}

val buildArcaneAndroidAppProjection by tasks.registering(Exec::class) {
    dependsOn(buildArcanePortableApps)
    outputs.upToDateWhen { false }
    workingDir("../..")
    commandLine(
        arcaneNodeExecutable,
        "tools/build-android-app-projection.mjs"
    )
}

val stageArcaneAndroidAssets by tasks.registering(Sync::class) {
    dependsOn(buildArcaneAndroidAppProjection)
    from("../../dist/android-apps") {
        include("catalog.json")
        include("*/arcane-app-content.json")
        include("*/arcane-app-package.json")
        include("*/app/**")
    }
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
    dependsOn(buildArcaneCoreAssets)
    dependsOn(stageArcaneAndroidAssets)
}

dependencies {
    implementation("androidx.annotation:annotation:1.9.1")
    implementation("androidx.webkit:webkit:1.16.0")

    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit-ktx:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
