package os.arcane.host.android

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

internal class ArcaneAndroidHostSession private constructor(
    context: Context,
    private val snapshot: ArcaneAndroidApplicationCatalog.Snapshot,
    launchDescriptor: ArcaneAndroidApplicationCatalog.LaunchDescriptor?
) :
    ArcaneWebViewBridge.CapabilityGrantProvider,
    ArcaneWebViewBridge.ApplicationIdentityProvider,
    ArcaneWebViewBridge.ApplicationCatalogProvider,
    ArcaneWebViewBridge.UserIdentityProvider,
    ArcaneWebViewBridge.PlatformStatusProvider {
    internal val applicationContext = context.applicationContext
    private val packageVersion = currentPackageVersion(applicationContext)
    private val applicationDescriptor = validatedApplication(packageVersion, launchDescriptor)
    private val grants = validatedGrants(launchDescriptor)
    private val applicationCatalog = snapshot.publicCatalog
    private val userIdentity = ArcaneWebViewBridge.UserIdentity(
        identityKind = "local-session",
        username = null,
        accountName = null,
        displayName = "Local user",
        source = "android"
    )
    private val status = ArcaneWebViewBridge.PlatformStatus(
        release = validatedStatus(Build.VERSION.RELEASE, "Android release"),
        architecture = currentArchitecture(),
        version = packageVersion,
        rendererVersion = null,
        application = applicationDescriptor
    )

    internal val entry: String = applicationDescriptor.entry
        ?: throw IllegalArgumentException("Android launcher entry is unavailable.")
    internal val assetRoot: String = launchDescriptor?.assetRoot ?: ""
    internal val originHost: String = launchDescriptor?.let { descriptor ->
        "${descriptor.id}.arcane.invalid"
    } ?: "appassets.androidplatform.net"
    internal val webViewProfileName: String = "arcane-app-${applicationDescriptor.id}"
    internal val networkAccessAllowed: Boolean = currentNetworkAccessPolicy(applicationContext)
    internal val navigationEntries: Set<String> = launchDescriptor?.navigationEntries?.toSet()
        ?: setOf(entry)

    override fun isGranted(capability: String): Boolean {
        return grants.contains(capability)
    }

    override fun currentStatus(): ArcaneWebViewBridge.PlatformStatus {
        return status.copy(application = status.application.copy())
    }

    override fun currentApplicationIdentity(): ArcaneWebViewBridge.ApplicationDescriptor {
        return applicationDescriptor.copy()
    }

    override fun currentApplicationCatalog(): ArcaneWebViewBridge.ApplicationCatalog {
        return applicationCatalog.copy(applications = applicationCatalog.applications.toList())
    }

    override fun currentUserIdentity(): ArcaneWebViewBridge.UserIdentity {
        return userIdentity.copy()
    }

    internal companion object {
        private const val NETWORK_ALLOWED_METADATA = "os.arcane.NETWORK_ALLOWED"

        internal fun createShell(context: Context): ArcaneAndroidHostSession {
            val snapshot = ArcaneAndroidApplicationCatalog(context).readInstalledSnapshot()
            return ArcaneAndroidHostSession(context, snapshot, null)
        }

        internal fun createApplication(context: Context, id: String): ArcaneAndroidHostSession {
            val catalog = ArcaneAndroidApplicationCatalog(context)
            val packagedSnapshot = catalog.readSnapshot()
            val descriptor = packagedSnapshot.requireLaunchDescriptor(id)
            val installedSnapshot = catalog.readInstalledSnapshot()
            return ArcaneAndroidHostSession(context, installedSnapshot, descriptor)
        }
    }

    private fun currentArchitecture(): String {
        for (architecture in Build.SUPPORTED_ABIS) {
            if (architecture.isNotEmpty()) {
                return validatedStatus(architecture, "Android architecture")
            }
        }
        throw IllegalStateException("Android architecture is unavailable.")
    }

    private fun validatedApplication(
        packageVersion: String,
        launchDescriptor: ArcaneAndroidApplicationCatalog.LaunchDescriptor?
    ): ArcaneWebViewBridge.ApplicationDescriptor {
        val application = if (launchDescriptor == null) {
            ArcaneWebViewBridge.ApplicationDescriptor(
                id = GeneratedAndroidApplicationRegistry.SHELL_ID,
                displayName = GeneratedAndroidApplicationRegistry.SHELL_DISPLAY_NAME,
                type = GeneratedAndroidApplicationRegistry.SHELL_TYPE,
                entry = GeneratedAndroidApplicationRegistry.SHELL_ENTRY,
                version = packageVersion
            )
        } else {
            ArcaneWebViewBridge.ApplicationDescriptor(
                id = launchDescriptor.id,
                displayName = launchDescriptor.displayName,
                type = launchDescriptor.type,
                entry = launchDescriptor.entry,
                version = packageVersion
            )
        }
        val protocolApplication = AndroidBridgeProtocol.Application(
            id = application.id,
            displayName = application.displayName,
            type = application.type,
            entry = application.entry,
            version = application.version
        )
        if (!AndroidBridgeProtocol.isValidApplication(protocolApplication)
            || application.entry == null) {
            throw IllegalArgumentException("Android launcher application identity is invalid.")
        }
        return application.copy()
    }

    private fun validatedGrants(
        launchDescriptor: ArcaneAndroidApplicationCatalog.LaunchDescriptor?
    ): Set<String> {
        if (launchDescriptor == null) return GeneratedAndroidApplicationRegistry.shellGrants().toSet()
        val supported = GeneratedAndroidCapabilityRegistry.grants.toSet()
        return launchDescriptor.requestedCapabilities.filterTo(linkedSetOf()) { capability ->
            supported.contains(capability)
        }.toSet()
    }

    private fun currentPackageVersion(context: Context): String {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val version = packageInfo.versionName
            ?: throw IllegalStateException("Android launcher package version is unavailable.")
        val validated = validatedStatus(version, "Android launcher package version")
        if (validated != GeneratedAndroidApplicationRegistry.BUNDLE_VERSION) {
            throw IllegalStateException("Android launcher package version does not match the Arcane bundle version.")
        }
        return validated
    }

    @Suppress("DEPRECATION")
    private fun currentNetworkAccessPolicy(context: Context): Boolean {
        val applicationInfo = context.packageManager.getApplicationInfo(
            context.packageName,
            PackageManager.GET_META_DATA
        )
        return applicationInfo.metaData?.getBoolean(NETWORK_ALLOWED_METADATA, false) == true
    }

    private fun validatedStatus(value: String, field: String): String {
        if (value.isEmpty() || value.length > Limits.MAX_STATUS_LENGTH) {
            throw IllegalArgumentException("$field is invalid.")
        }
        for (character in value) {
            if (character.code <= 31 || character.code == 127) {
                throw IllegalArgumentException("$field is invalid.")
            }
        }
        return value
    }

    private object Limits {
        const val MAX_STATUS_LENGTH = 256
    }

}
