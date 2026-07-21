package os.arcane.host.android

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

object ArcaneWebViewBridge {
    const val TRUSTED_ORIGIN = "https://appassets.androidplatform.net"
    const val BRIDGE_NAME = "arcaneAndroid"

    data class ApplicationDescriptor(
        val id: String,
        val displayName: String,
        val type: String,
        val entry: String?,
        val version: String
    )

    data class ApplicationCatalogRecord(
        val id: String,
        val displayName: String,
        val description: String,
        val iconUrl: String,
        val version: String,
        val order: Int,
        val verified: Boolean
    )

    data class ApplicationCatalog(
        val verified: Boolean,
        val securityMode: String,
        val publisherTrustSource: String?,
        val revocationStatus: String?,
        val applications: List<ApplicationCatalogRecord>
    )

    data class PlatformStatus(
        val release: String,
        val architecture: String,
        val version: String,
        val rendererVersion: String?,
        val application: ApplicationDescriptor
    )

    data class NetworkStatus(
        val online: Boolean,
        val interfaceCount: Int
    )

    data class UserIdentity(
        val identityKind: String,
        val username: String?,
        val accountName: String?,
        val displayName: String,
        val source: String
    )

    fun interface PlatformStatusProvider {
        fun currentStatus(): PlatformStatus
    }

    fun interface ApplicationIdentityProvider {
        fun currentApplicationIdentity(): ApplicationDescriptor
    }

    fun interface ApplicationCatalogProvider {
        fun currentApplicationCatalog(): ApplicationCatalog
    }

    fun interface UserIdentityProvider {
        fun currentUserIdentity(): UserIdentity
    }

    fun interface CapabilityGrantProvider {
        fun isGranted(capability: String): Boolean
    }

    fun interface ApplicationLaunchProvider {
        fun launchApplication(id: String): Boolean
    }

    fun interface ExternalOpenProvider {
        fun openMailto(uri: String): Boolean
    }

    fun interface NetworkStatusProvider {
        fun currentNetworkStatus(): NetworkStatus
    }

    internal interface TerminalProvider {
        fun setEventSink(sink: ((String) -> Unit)?)
        fun start(parameters: AndroidBridgeProtocol.TerminalParameters): AndroidBridgeProtocol.TerminalSession
        fun list(): List<AndroidBridgeProtocol.TerminalSession>
        fun write(sessionId: String, data: String): Int
        fun resize(sessionId: String, columns: Int, rows: Int)
        fun signal(sessionId: String, signal: String): Boolean
        fun close(sessionId: String)
        fun closeAll()
    }

    internal class TerminalFailure(val code: String, override val message: String) : Exception(message)

    @Suppress("DEPRECATION")
    internal fun install(
        webView: WebView,
        expectedOrigin: String,
        expectedApplicationEntry: String,
        applicationIdentityProvider: ApplicationIdentityProvider,
        applicationCatalogProvider: ApplicationCatalogProvider,
        userIdentityProvider: UserIdentityProvider,
        capabilityGrantProvider: CapabilityGrantProvider,
        platformStatusProvider: PlatformStatusProvider,
        applicationLaunchProvider: ApplicationLaunchProvider,
        externalOpenProvider: ExternalOpenProvider,
        networkStatusProvider: NetworkStatusProvider,
        terminalProvider: TerminalProvider?
    ): Boolean {
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.settings.allowFileAccessFromFileURLs = false
        webView.settings.allowUniversalAccessFromFileURLs = false

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            return false
        }

        val trustedOrigin = validatedTrustedOrigin(expectedOrigin) ?: return false
        val applicationIdentity = try {
            applicationIdentityProvider.currentApplicationIdentity().copy()
        } catch (_: Exception) {
            return false
        }
        val protocolApplicationIdentity = AndroidBridgeProtocol.Application(
            applicationIdentity.id,
            applicationIdentity.displayName,
            applicationIdentity.type,
            applicationIdentity.entry,
            applicationIdentity.version
        )
        if (applicationIdentity.entry != expectedApplicationEntry
            || !AndroidBridgeProtocol.isValidApplication(protocolApplicationIdentity)) {
            return false
        }
        val userIdentity = try {
            userIdentityProvider.currentUserIdentity().copy()
        } catch (_: Exception) {
            return false
        }
        if (!AndroidBridgeProtocol.isValidUserIdentity(userIdentity)) {
            return false
        }

        val listener = Listener(
            expectedApplicationEntry,
            trustedOrigin,
            applicationIdentity,
            userIdentity,
            applicationCatalogProvider,
            capabilityGrantProvider,
            platformStatusProvider,
            applicationLaunchProvider,
            externalOpenProvider,
            networkStatusProvider,
            terminalProvider
        )
        WebViewCompat.addWebMessageListener(
            webView,
            BRIDGE_NAME,
            setOf(expectedOrigin),
            listener
        )
        terminalProvider?.setEventSink { encoded -> listener.postNativeMessage(webView, encoded) }
        return true
    }

    private class Listener(
        private val expectedApplicationEntry: String,
        private val trustedOrigin: Uri,
        private val applicationIdentity: ApplicationDescriptor,
        private val userIdentity: UserIdentity,
        private val applicationCatalogProvider: ApplicationCatalogProvider,
        private val capabilityGrantProvider: CapabilityGrantProvider,
        private val platformStatusProvider: PlatformStatusProvider,
        private val applicationLaunchProvider: ApplicationLaunchProvider,
        private val externalOpenProvider: ExternalOpenProvider,
        private val networkStatusProvider: NetworkStatusProvider,
        private val terminalProvider: TerminalProvider?
    ) : WebViewCompat.WebMessageListener {
        private val replayWindow = AndroidBridgeProtocol.ReplayWindow()
        @Volatile
        private var nativeReplyProxy: JavaScriptReplyProxy? = null

        private data class GrantedCapabilities(
            val grants: List<String>,
            val methods: List<String>
        )

        override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: Uri,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy
        ) {
            if (!isMainFrame || !isTrustedOrigin(sourceOrigin, trustedOrigin)) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse("", "ANDROID_BRIDGE_UNTRUSTED_SOURCE", "Arcane rejected an untrusted Android WebView message."))
                return
            }
            nativeReplyProxy = replyProxy

            if (message.type != WebMessageCompat.TYPE_STRING) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse("", "ANDROID_BRIDGE_INVALID_REQUEST", "Arcane requires a string Android WebView request."))
                return
            }
            val encoded = message.data
            if (encoded == null) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse("", "ANDROID_BRIDGE_INVALID_REQUEST", "Arcane rejected an empty Android WebView request."))
                return
            }
            if (AndroidBridgeProtocol.isOversized(encoded)) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse("", "ANDROID_BRIDGE_MESSAGE_TOO_LARGE", "Arcane rejected an oversized Android WebView message."))
                return
            }

            val request = AndroidBridgeProtocol.parseRequest(encoded)
            if (request == null) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse("", "ANDROID_BRIDGE_INVALID_REQUEST", "Arcane rejected an invalid Android WebView request."))
                return
            }
            if (!GeneratedAndroidCapabilityRegistry.isSupported(request.method)) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_CAPABILITY_UNSUPPORTED", "This Arcane capability is not available from the Android launcher."))
                return
            }
            if (request.method == GeneratedAndroidCapabilityRegistry.SYSTEM_PING_METHOD
                || request.method == GeneratedAndroidCapabilityRegistry.VERSION_CURRENT_METHOD
                || request.method == GeneratedAndroidCapabilityRegistry.APP_CURRENT_METHOD) {
                if (!replayWindow.remember(request.id)) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_BRIDGE_DUPLICATE_REQUEST", "Arcane rejected a duplicate Android WebView request."))
                    return
                }
                if (request.method == GeneratedAndroidCapabilityRegistry.SYSTEM_PING_METHOD) {
                    replyProxy.postMessage(AndroidBridgeProtocol.systemPingResponse(request))
                    return
                }
                val protocolApplication = AndroidBridgeProtocol.Application(applicationIdentity.id, applicationIdentity.displayName, applicationIdentity.type, applicationIdentity.entry, applicationIdentity.version)
                if (request.method == GeneratedAndroidCapabilityRegistry.VERSION_CURRENT_METHOD) {
                    replyProxy.postMessage(AndroidBridgeProtocol.versionCurrentResponse(request, protocolApplication.version))
                } else {
                    replyProxy.postMessage(AndroidBridgeProtocol.appCurrentResponse(request, protocolApplication))
                }
                return
            }
            val grantedCapabilities = readGrantedCapabilities()
            if (!grantedCapabilities.methods.contains(request.method)) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_CAPABILITY_DENIED", "This Android launcher session is not granted the requested capability."))
                return
            }
            if (!replayWindow.remember(request.id)) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_BRIDGE_DUPLICATE_REQUEST", "Arcane rejected a duplicate Android WebView request."))
                return
            }
            if (request.method == GeneratedAndroidCapabilityRegistry.USER_CURRENT_METHOD) {
                replyProxy.postMessage(AndroidBridgeProtocol.userCurrentResponse(request, userIdentity))
                return
            }
            if (request.method == GeneratedAndroidCapabilityRegistry.APPS_LIST_METHOD) {
                val catalog = try {
                    applicationCatalogProvider.currentApplicationCatalog()
                } catch (_: Exception) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "APPLICATION_CATALOG_UNAVAILABLE", "Arcane could not read the packaged Android application catalog."))
                    return
                }
                replyProxy.postMessage(AndroidBridgeProtocol.applicationCatalogResponse(request, catalog))
                return
            }
            if (request.method == GeneratedAndroidCapabilityRegistry.APPS_LAUNCH_METHOD) {
                val applicationId = request.applicationId
                if (applicationId == null) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_BRIDGE_INVALID_REQUEST", "Arcane rejected an invalid Android application launch request."))
                    return
                }
                val accepted = try {
                    applicationLaunchProvider.launchApplication(applicationId)
                } catch (_: Exception) {
                    false
                }
                if (!accepted) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "APPLICATION_LAUNCH_FAILED", "Android could not launch that Arcane application."))
                    return
                }
                replyProxy.postMessage(AndroidBridgeProtocol.applicationLaunchResponse(request, applicationId))
                return
            }
            val status = try {
                platformStatusProvider.currentStatus()
            } catch (_: Exception) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_STATUS_UNAVAILABLE", "Arcane could not read Android platform status."))
                return
            }
            if (status.application.entry != expectedApplicationEntry) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_APPLICATION_IDENTITY_MISMATCH", "The Android host application identity does not match the loaded entry."))
                return
            }
            if (status.application != applicationIdentity || status.version != applicationIdentity.version) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_APPLICATION_IDENTITY_MISMATCH", "The Android platform status does not match the bound application identity."))
                return
            }
            val application = AndroidBridgeProtocol.Application(
                id = status.application.id,
                displayName = status.application.displayName,
                type = status.application.type,
                entry = status.application.entry,
                version = status.application.version
            )
            if (!AndroidBridgeProtocol.isValidApplication(application)) {
                replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_APPLICATION_IDENTITY_INVALID", "The Android host supplied an invalid Arcane application identity."))
                return
            }
            if (isTerminalMethod(request.method)) {
                val provider = terminalProvider
                val parameters = request.terminal
                if (provider == null || parameters == null) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_TERMINAL_UNAVAILABLE", "The Android application-sandbox terminal is unavailable."))
                    return
                }
                try {
                    when (request.method) {
                        GeneratedAndroidCapabilityRegistry.TERMINAL_START_METHOD -> {
                            replyProxy.postMessage(AndroidBridgeProtocol.terminalStartResponse(request, provider.start(parameters)))
                        }
                        GeneratedAndroidCapabilityRegistry.TERMINAL_LIST_METHOD -> {
                            replyProxy.postMessage(AndroidBridgeProtocol.terminalListResponse(request, provider.list()))
                        }
                        GeneratedAndroidCapabilityRegistry.TERMINAL_WRITE_METHOD -> {
                            val sessionId = requireNotNull(parameters.sessionId)
                            val data = requireNotNull(parameters.data)
                            replyProxy.postMessage(AndroidBridgeProtocol.terminalWriteResponse(request, sessionId, provider.write(sessionId, data)))
                        }
                        GeneratedAndroidCapabilityRegistry.TERMINAL_RESIZE_METHOD -> {
                            val sessionId = requireNotNull(parameters.sessionId)
                            val columns = requireNotNull(parameters.columns)
                            val rows = requireNotNull(parameters.rows)
                            provider.resize(sessionId, columns, rows)
                            replyProxy.postMessage(AndroidBridgeProtocol.terminalResizeResponse(request, sessionId, columns, rows))
                        }
                        GeneratedAndroidCapabilityRegistry.TERMINAL_SIGNAL_METHOD -> {
                            val sessionId = requireNotNull(parameters.sessionId)
                            val signal = requireNotNull(parameters.signal)
                            replyProxy.postMessage(AndroidBridgeProtocol.terminalSignalResponse(request, sessionId, signal, provider.signal(sessionId, signal)))
                        }
                        GeneratedAndroidCapabilityRegistry.TERMINAL_CLOSE_METHOD -> {
                            val sessionId = requireNotNull(parameters.sessionId)
                            provider.close(sessionId)
                            replyProxy.postMessage(AndroidBridgeProtocol.terminalCloseResponse(request, sessionId))
                        }
                    }
                } catch (error: TerminalFailure) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, error.code, error.message))
                } catch (_: Exception) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_TERMINAL_FAILED", "Android could not complete the terminal operation."))
                }
                return
            }
            if (request.method == GeneratedAndroidCapabilityRegistry.EXTERNAL_OPEN_METHOD) {
                val uri = request.externalUri
                if (uri == null) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "ANDROID_BRIDGE_INVALID_REQUEST", "Arcane rejected an invalid Android external-open request."))
                    return
                }
                val canonicalUri = AndroidBridgeProtocol.canonicalMailtoUri(uri)
                if (canonicalUri == null) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "EXTERNAL_SCHEME_NOT_ALLOWED", "That external URI scheme is not allowed."))
                    return
                }
                val opened = try {
                    externalOpenProvider.openMailto(canonicalUri)
                } catch (_: Exception) {
                    false
                }
                if (!opened) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "EXTERNAL_OPEN_FAILED", "Android did not accept the mail link."))
                    return
                }
                replyProxy.postMessage(AndroidBridgeProtocol.externalOpenResponse(request, canonicalUri))
                return
            }
            if (request.method == GeneratedAndroidCapabilityRegistry.NETWORK_STATUS_METHOD) {
                val networkStatus = try {
                    networkStatusProvider.currentNetworkStatus()
                } catch (_: Exception) {
                    replyProxy.postMessage(AndroidBridgeProtocol.errorResponse(request.id, "NETWORK_STATUS_UNAVAILABLE", "Android could not read network status."))
                    return
                }
                replyProxy.postMessage(
                    AndroidBridgeProtocol.networkStatusResponse(
                        request,
                        networkStatus.online,
                        networkStatus.interfaceCount
                    )
                )
                return
            }
            val protocolStatus = AndroidBridgeProtocol.Status(
                release = status.release,
                architecture = status.architecture,
                version = status.version,
                rendererVersion = status.rendererVersion,
                application = application
            )
            replyProxy.postMessage(
                AndroidBridgeProtocol.statusResponseFor(
                    request,
                    protocolStatus,
                    grantedCapabilities.grants,
                    grantedCapabilities.methods
                )
            )
        }

        private fun readGrantedCapabilities(): GrantedCapabilities {
            val grants = mutableListOf<String>()
            val methods = mutableListOf<String>()
            for (method in GeneratedAndroidCapabilityRegistry.methods) {
                if (isTerminalMethod(method) && terminalProvider == null) continue
                if (!GeneratedAndroidCapabilityRegistry.isAllowedForApplication(
                        method,
                        applicationIdentity.id,
                        applicationIdentity.type
                    )) {
                    continue
                }
                val methodCapability = GeneratedAndroidCapabilityRegistry.capabilityFor(method)
                if (methodCapability == null) {
                    methods.add(method)
                    continue
                }
                val methodGranted = try {
                    capabilityGrantProvider.isGranted(methodCapability)
                } catch (_: Exception) {
                    false
                }
                if (methodGranted) {
                    if (!grants.contains(methodCapability)) grants.add(methodCapability)
                    methods.add(method)
                }
            }
            grants.sort()
            methods.sort()
            return GrantedCapabilities(grants, methods)
        }

        fun postNativeMessage(view: WebView, encoded: String) {
            view.post {
                try {
                    nativeReplyProxy?.postMessage(encoded)
                } catch (_: Exception) {
                }
            }
        }

        private fun isTerminalMethod(method: String): Boolean {
            return method in setOf(
                GeneratedAndroidCapabilityRegistry.TERMINAL_START_METHOD,
                GeneratedAndroidCapabilityRegistry.TERMINAL_LIST_METHOD,
                GeneratedAndroidCapabilityRegistry.TERMINAL_WRITE_METHOD,
                GeneratedAndroidCapabilityRegistry.TERMINAL_RESIZE_METHOD,
                GeneratedAndroidCapabilityRegistry.TERMINAL_SIGNAL_METHOD,
                GeneratedAndroidCapabilityRegistry.TERMINAL_CLOSE_METHOD
            )
        }
    }

    private fun validatedTrustedOrigin(value: String): Uri? {
        val origin = Uri.parse(value)
        if (origin.scheme != "https"
            || origin.host == null
            || origin.port != -1
            || origin.userInfo != null
            || origin.path?.isNotEmpty() == true
            || origin.query != null
            || origin.fragment != null
            || origin.toString() != value) {
            return null
        }
        return origin
    }

    private fun isTrustedOrigin(origin: Uri, expected: Uri): Boolean {
        return origin.scheme == expected.scheme
            && origin.host == expected.host
            && origin.port == expected.port
            && origin.userInfo == null
    }

}
