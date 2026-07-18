package os.arcane.host.android

internal object GeneratedAndroidCapabilityRegistry {
    internal const val APP_CURRENT_METHOD = "app.current"
    internal const val EXTERNAL_OPEN_METHOD = "external.open"
    internal const val EXTERNAL_OPEN_CAPABILITY = "external.open"
    internal const val NETWORK_STATUS_METHOD = "network.status"
    internal const val NETWORK_STATUS_CAPABILITY = "network.status.read"
    internal const val PLATFORM_STATUS_METHOD = "platform.status"
    internal const val PLATFORM_STATUS_CAPABILITY = "system.read"
    internal const val SYSTEM_PING_METHOD = "system.ping"
    internal const val USER_CURRENT_METHOD = "user.current"
    internal const val USER_CURRENT_CAPABILITY = "identity.read"
    internal const val VERSION_CURRENT_METHOD = "version.current"
    internal val grants = listOf(EXTERNAL_OPEN_CAPABILITY, NETWORK_STATUS_CAPABILITY, PLATFORM_STATUS_CAPABILITY, USER_CURRENT_CAPABILITY)
    internal val methods = listOf(APP_CURRENT_METHOD, EXTERNAL_OPEN_METHOD, NETWORK_STATUS_METHOD, PLATFORM_STATUS_METHOD, SYSTEM_PING_METHOD, USER_CURRENT_METHOD, VERSION_CURRENT_METHOD)

    internal fun isSupported(method: String): Boolean {
        return methods.contains(method)
    }

    internal fun capabilityFor(method: String): String? {
        if (method == EXTERNAL_OPEN_METHOD) return EXTERNAL_OPEN_CAPABILITY
        if (method == NETWORK_STATUS_METHOD) return NETWORK_STATUS_CAPABILITY
        if (method == PLATFORM_STATUS_METHOD) return PLATFORM_STATUS_CAPABILITY
        if (method == USER_CURRENT_METHOD) return USER_CURRENT_CAPABILITY
        return null
    }
}
