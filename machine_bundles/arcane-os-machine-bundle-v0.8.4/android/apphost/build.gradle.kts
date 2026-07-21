import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

data class ArcaneAndroidApp(
    val id: String,
    val flavor: String,
    val packageName: String,
    val displayName: String,
    val networkAccess: Boolean
)

fun quoted(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val registryFile = file("../../arcane-apps.json")
@Suppress("UNCHECKED_CAST")
val registryRoot = JsonSlurper().parse(registryFile) as Map<String, Any?>
@Suppress("UNCHECKED_CAST")
val registryApps = registryRoot["apps"] as Map<String, Map<String, Any?>>
val arcaneApps = registryApps.map { (id, descriptor) ->
    val flavor = id.replace('-', '_')
    @Suppress("UNCHECKED_CAST")
    val security = descriptor["security"] as Map<String, Any?>
    val networkAccess = listOf("connectOrigins", "frameOrigins", "mediaOrigins").any { key ->
        @Suppress("UNCHECKED_CAST")
        val origins = security[key] as? List<String> ?: emptyList()
        origins.isNotEmpty()
    }
    ArcaneAndroidApp(
        id = id,
        flavor = flavor,
        packageName = "os.arcane.app.$flavor",
        displayName = descriptor["displayName"] as String,
        networkAccess = networkAccess
    )
}.sortedBy { it.id }

android {
    namespace = "os.arcane.host.android"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
        targetSdk = 35
        versionCode = 804
        versionName = "0.8.4"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    flavorDimensions += "application"
    productFlavors {
        for (application in arcaneApps) {
            create(application.flavor) {
                dimension = "application"
                applicationId = application.packageName
                buildConfigField("String", "ARCANE_APP_ID", quoted(application.id))
                buildConfigField("boolean", "ARCANE_NETWORK_ALLOWED", application.networkAccess.toString())
                manifestPlaceholders["arcaneAppLabel"] = application.displayName
                manifestPlaceholders["arcaneNetworkAllowed"] = application.networkAccess.toString()
            }
        }
    }

    sourceSets {
        getByName("main") {
            java.srcDir("../../src/hosts/android")
            res.srcDir("../app/src/main/res")
        }
        for (application in arcaneApps) {
            getByName(application.flavor) {
                assets.srcDir("../../dist/android-build-assets/apps/${application.flavor}")
                if (!application.networkAccess) {
                    manifest.srcFile("src/noNetwork/AndroidManifest.xml")
                }
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isDebuggable = false
        }
    }

    buildFeatures {
        buildConfig = true
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
    dependsOn(rootProject.tasks.named("buildArcaneAndroidDistributionAssets"))
}

dependencies {
    implementation("androidx.annotation:annotation:1.9.1")
    implementation("androidx.webkit:webkit:1.16.0")

    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit-ktx:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
