package os.arcane.host.android

import android.content.Context
import android.os.Build

internal class ArcaneAndroidHostSession private constructor(
    context: Context
) :
    ArcaneWebViewBridge.CapabilityGrantProvider,
    ArcaneWebViewBridge.ApplicationIdentityProvider,
    ArcaneWebViewBridge.UserIdentityProvider,
    ArcaneWebViewBridge.PlatformStatusProvider {
    internal val applicationContext = context.applicationContext
    private val packageVersion = currentPackageVersion(applicationContext)
    private val applicationDescriptor = validatedApplication(packageVersion)
    private val grants = GeneratedAndroidApplicationRegistry.shellGrants().toSet()
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

    override fun isGranted(capability: String): Boolean {
        return grants.contains(capability)
    }

    override fun currentStatus(): ArcaneWebViewBridge.PlatformStatus {
        return status
    }

    override fun currentApplicationIdentity(): ArcaneWebViewBridge.ApplicationDescriptor {
        return applicationDescriptor.copy()
    }

    override fun currentUserIdentity(): ArcaneWebViewBridge.UserIdentity {
        return userIdentity.copy()
    }

    internal val entry: String
        get() = GeneratedAndroidApplicationRegistry.SHELL_ENTRY

    internal companion object {
        internal fun createShell(context: Context): ArcaneAndroidHostSession {
            return ArcaneAndroidHostSession(context)
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

    private fun validatedApplication(packageVersion: String): ArcaneWebViewBridge.ApplicationDescriptor {
        val application = ArcaneWebViewBridge.ApplicationDescriptor(
            id = GeneratedAndroidApplicationRegistry.SHELL_ID,
            displayName = GeneratedAndroidApplicationRegistry.SHELL_DISPLAY_NAME,
            type = GeneratedAndroidApplicationRegistry.SHELL_TYPE,
            entry = GeneratedAndroidApplicationRegistry.SHELL_ENTRY,
            version = packageVersion
        )
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
