plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}

val arcaneNodeExecutable = providers.gradleProperty("arcaneNodeExecutable").getOrElse("node")

val buildArcaneCoreAssets by tasks.registering(Exec::class) {
    workingDir("..")
    commandLine(arcaneNodeExecutable, "tools/build-core.mjs")
}

val buildArcaneAndroidPortableApps by tasks.registering(Exec::class) {
    outputs.upToDateWhen { false }
    workingDir("..")
    commandLine(arcaneNodeExecutable, "tools/build-android-portable-apps.mjs")
}

val buildArcaneAndroidAppProjection by tasks.registering(Exec::class) {
    dependsOn(buildArcaneAndroidPortableApps)
    outputs.upToDateWhen { false }
    workingDir("..")
    commandLine(
        arcaneNodeExecutable,
        "tools/build-android-app-projection.mjs",
        "--targets-root=dist/targets/.android-portable"
    )
}

val buildArcaneAndroidDistributionAssets by tasks.registering(Exec::class) {
    dependsOn(buildArcaneAndroidAppProjection)
    outputs.upToDateWhen { false }
    workingDir("..")
    commandLine(arcaneNodeExecutable, "tools/build-android-distribution-assets.mjs")
}
