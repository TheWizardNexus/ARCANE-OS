package os.arcane.host.android

internal object GeneratedAndroidCapabilityRegistry {
    internal const val APP_CURRENT_METHOD = "app.current"
    internal const val APPS_LAUNCH_METHOD = "apps.launch"
    internal const val APPS_LAUNCH_CAPABILITY = "applications.launch"
    internal const val APPS_LIST_METHOD = "apps.list"
    internal const val APPS_LIST_CAPABILITY = "applications.read"
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
    internal val grants = listOf(APPS_LAUNCH_CAPABILITY, APPS_LIST_CAPABILITY, EXTERNAL_OPEN_CAPABILITY, NETWORK_STATUS_CAPABILITY, PLATFORM_STATUS_CAPABILITY, USER_CURRENT_CAPABILITY)
    internal val methods = listOf(APP_CURRENT_METHOD, APPS_LAUNCH_METHOD, APPS_LIST_METHOD, EXTERNAL_OPEN_METHOD, NETWORK_STATUS_METHOD, PLATFORM_STATUS_METHOD, SYSTEM_PING_METHOD, USER_CURRENT_METHOD, VERSION_CURRENT_METHOD)

    internal fun isSupported(method: String): Boolean {
        return methods.contains(method)
    }

    internal fun capabilityFor(method: String): String? {
        if (method == APPS_LAUNCH_METHOD) return APPS_LAUNCH_CAPABILITY
        if (method == APPS_LIST_METHOD) return APPS_LIST_CAPABILITY
        if (method == EXTERNAL_OPEN_METHOD) return EXTERNAL_OPEN_CAPABILITY
        if (method == NETWORK_STATUS_METHOD) return NETWORK_STATUS_CAPABILITY
        if (method == PLATFORM_STATUS_METHOD) return PLATFORM_STATUS_CAPABILITY
        if (method == USER_CURRENT_METHOD) return USER_CURRENT_CAPABILITY
        return null
    }

    internal fun isAllowedForApplication(method: String, applicationId: String, applicationType: String): Boolean {
        if (method == APPS_LAUNCH_METHOD) return applicationId in setOf("shell", "terminal")
        if (method == APPS_LIST_METHOD) return applicationId in setOf("shell", "terminal")
        return isSupported(method)
    }
}
