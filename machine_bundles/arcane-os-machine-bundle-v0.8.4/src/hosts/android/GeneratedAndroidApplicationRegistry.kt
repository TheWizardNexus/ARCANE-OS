package os.arcane.host.android

import java.util.Collections
import java.util.LinkedHashSet

internal object GeneratedAndroidApplicationRegistry {
    internal const val BUNDLE_VERSION = "0.8.4"
    internal const val SHELL_ID = "shell"
    internal const val SHELL_DISPLAY_NAME = "Arcane Shell"
    internal const val SHELL_TYPE = "shell"
    internal const val SHELL_ENTRY = "shell/index.html"

    internal fun shellGrants(): Set<String> {
        val grants = LinkedHashSet<String>()
        grants.add(GeneratedAndroidCapabilityRegistry.NETWORK_STATUS_CAPABILITY)
        grants.add(GeneratedAndroidCapabilityRegistry.PLATFORM_STATUS_CAPABILITY)
        grants.add(GeneratedAndroidCapabilityRegistry.USER_CURRENT_CAPABILITY)
        return Collections.unmodifiableSet(grants)
    }
}
