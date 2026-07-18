package os.arcane.host.android

import android.content.Context
import android.net.Uri
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.annotation.UiThread
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.URLConnection
import java.util.Locale

internal class ArcaneWebViewHostController(
    private val hostSession: ArcaneAndroidHostSession
) {
    private val trustedOrigin = "https://${hostSession.originHost}"
    private val urlPathPrefix = if (hostSession.assetRoot.isEmpty()) ASSET_PREFIX else ROOT_ASSET_PREFIX
    private val allowedEntry = canonicalEntryPath(hostSession.entry)
    private val allowedEntryUri = entryUri(allowedEntry)
    private val allowedNavigationUris = hostSession.navigationEntries
        .map { entry -> entryUri(canonicalEntryPath(entry)) }
        .toSet()
    private val assetPathHandler: WebViewAssetLoader.PathHandler = if (hostSession.assetRoot.isEmpty()) {
        WebViewAssetLoader.AssetsPathHandler(hostSession.applicationContext)
    } else {
        ScopedAssetsPathHandler(hostSession.applicationContext, hostSession.assetRoot)
    }
    private val assetLoader = WebViewAssetLoader.Builder()
        .setDomain(hostSession.originHost)
        .setHttpAllowed(false)
        .addPathHandler(urlPathPrefix, assetPathHandler)
        .build()
    init {
        require(allowedNavigationUris.contains(allowedEntryUri))
    }
    private var installedWebView: WebView? = null
    private var installedLooper: Looper? = null
    private var lifecycle = Lifecycle.NEW

    data class CloseResult(
        val authorityRevoked: Boolean,
        val destroyed: Boolean,
        val retryable: Boolean,
        val failures: List<String>
    )

    data class InstallResult(
        val installed: Boolean,
        val cleanupRequired: Boolean,
        val closeResult: CloseResult?,
        val errorCode: String?
    )

    @UiThread
    fun install(
        webView: WebView,
        applicationLaunchProvider: ArcaneWebViewBridge.ApplicationLaunchProvider,
        externalOpenProvider: ArcaneWebViewBridge.ExternalOpenProvider,
        networkStatusProvider: ArcaneWebViewBridge.NetworkStatusProvider
    ): InstallResult {
        if (lifecycle != Lifecycle.NEW) {
            return InstallResult(false, lifecycle != Lifecycle.CLOSED, null, "CONTROLLER_ALREADY_USED")
        }
        val currentLooper = Looper.myLooper()
            ?: return InstallResult(false, false, null, "INSTALL_THREAD_UNAVAILABLE")
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            webView.destroy()
            return InstallResult(false, false, null, "WEBVIEW_MULTI_PROFILE_UNSUPPORTED")
        }
        installedWebView = webView
        installedLooper = currentLooper
        lifecycle = Lifecycle.CLOSING
        try {
            WebViewCompat.setProfile(webView, hostSession.webViewProfileName)
            if (WebViewCompat.getProfile(webView).name != hostSession.webViewProfileName) {
                throw IllegalStateException("Android WebView profile assignment did not persist.")
            }
        } catch (_: Exception) {
            val closeResult = close(webView)
            return InstallResult(false, closeResult.retryable, closeResult, "WEBVIEW_PROFILE_ASSIGNMENT_FAILED")
        }
        try {
            hardenSettings(webView.settings)
            hardenServiceWorkers(webView)
        } catch (_: Exception) {
            val closeResult = close(webView)
            return InstallResult(false, closeResult.retryable, closeResult, "WEBVIEW_PROFILE_SETUP_FAILED")
        }
        val bridgeInstalled = try {
            ArcaneWebViewBridge.install(
                webView,
                trustedOrigin,
                allowedEntry,
                hostSession,
                hostSession,
                hostSession,
                hostSession,
                hostSession,
                applicationLaunchProvider,
                externalOpenProvider,
                networkStatusProvider
            )
        } catch (_: Exception) {
            val closeResult = close(webView)
            return InstallResult(false, closeResult.retryable, closeResult, "BRIDGE_INSTALL_FAILED")
        }
        if (!bridgeInstalled) {
            resetUninstalled()
            return InstallResult(false, false, null, "WEB_MESSAGE_LISTENER_UNSUPPORTED")
        }
        try {
            webView.webViewClient = Client()
            webView.settings.javaScriptEnabled = true
        } catch (_: Exception) {
            val closeResult = close(webView)
            return InstallResult(false, closeResult.retryable, closeResult, "WEBVIEW_SETUP_FAILED")
        }
        lifecycle = Lifecycle.INSTALLED
        return InstallResult(true, false, null, null)
    }

    @UiThread
    fun close(webView: WebView): CloseResult {
        if (lifecycle == Lifecycle.CLOSED) {
            return CloseResult(false, false, false, listOf("CONTROLLER_ALREADY_CLOSED"))
        }
        if (lifecycle == Lifecycle.NEW) {
            return CloseResult(false, false, false, listOf("CONTROLLER_NOT_INSTALLED"))
        }
        if (installedWebView !== webView) {
            return CloseResult(false, false, true, listOf("WEBVIEW_MISMATCH"))
        }
        if (Looper.myLooper() !== installedLooper) {
            return CloseResult(false, false, true, listOf("WRONG_THREAD"))
        }

        var authorityRevoked = lifecycle == Lifecycle.AUTHORITY_REVOKED
        lifecycle = if (authorityRevoked) Lifecycle.AUTHORITY_REVOKED else Lifecycle.CLOSING
        val failures = mutableListOf<String>()
        if (!authorityRevoked) {
            try {
                if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    WebViewCompat.removeWebMessageListener(webView, ArcaneWebViewBridge.BRIDGE_NAME)
                    authorityRevoked = true
                } else {
                    failures.add("WEB_MESSAGE_LISTENER_UNSUPPORTED")
                }
            } catch (_: Exception) {
                authorityRevoked = false
                failures.add("BRIDGE_REMOVAL_FAILED")
            }
        }
        try {
            webView.stopLoading()
        } catch (_: Exception) {
            failures.add("STOP_LOADING_FAILED")
        }
        val parent = webView.parent
        if (parent is ViewGroup) {
            try {
                parent.removeView(webView)
            } catch (_: Exception) {
                failures.add("PARENT_DETACH_FAILED")
            }
        } else if (parent != null) {
            failures.add("PARENT_DETACH_UNSUPPORTED")
        }
        var destroyed = false
        try {
            if (webView.parent == null) {
                webView.destroy()
                destroyed = true
                authorityRevoked = true
            }
        } catch (_: Exception) {
            failures.add("WEBVIEW_DESTROY_FAILED")
        }
        if (!destroyed && webView.parent != null && !failures.contains("PARENT_DETACH_FAILED")) {
            failures.add("WEBVIEW_STILL_ATTACHED")
        }

        if (destroyed) {
            lifecycle = Lifecycle.CLOSED
            installedWebView = null
            installedLooper = null
        } else if (authorityRevoked) {
            lifecycle = Lifecycle.AUTHORITY_REVOKED
        }
        return CloseResult(authorityRevoked, destroyed, !destroyed, failures.toList())
    }

    @UiThread
    fun loadEntry(webView: WebView): Boolean {
        if (lifecycle != Lifecycle.INSTALLED) return false
        if (installedWebView !== webView || Looper.myLooper() !== installedLooper) return false
        webView.loadUrl(allowedEntryUri)
        return true
    }

    @Suppress("DEPRECATION")
    private fun hardenSettings(settings: WebSettings) {
        settings.javaScriptEnabled = false
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = false
    }

    private fun resetUninstalled() {
        installedWebView = null
        installedLooper = null
        lifecycle = Lifecycle.NEW
    }

    private fun hardenServiceWorkers(webView: WebView) {
        val settings = WebViewCompat.getProfile(webView).serviceWorkerController.serviceWorkerWebSettings
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.blockNetworkLoads = true
    }

    private inner class Client : WebViewClientCompat() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            return !isAllowedNavigation(request.url)
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            if (!isTrustedAssetUri(uri) || !isInsideSessionAssetRoot(uri)) {
                return forbiddenResponse()
            }
            if (!request.method.equals("GET", ignoreCase = false) || !hasSafeAssetPath(uri)) {
                return forbiddenResponse()
            }
            if (request.isForMainFrame && !isAllowedNavigation(uri)) {
                return forbiddenResponse()
            }
            return assetLoader.shouldInterceptRequest(uri) ?: forbiddenResponse()
        }

    }

    private fun isAllowedNavigation(uri: Uri): Boolean {
        if (!isTrustedAssetUri(uri) || !hasSafeAssetPath(uri)) return false
        if (uri.query != null || uri.fragment != null) return false
        return allowedNavigationUris.contains(uri.toString())
    }

    private fun isTrustedAssetUri(uri: Uri): Boolean {
        return uri.scheme == "https"
            && uri.host == hostSession.originHost
            && uri.port == -1
            && uri.userInfo == null
            && uri.path?.startsWith(urlPathPrefix) == true
    }

    private fun hasSafeAssetPath(uri: Uri): Boolean {
        val encodedPath = uri.encodedPath ?: return false
        val normalizedEncodedPath = encodedPath.lowercase(Locale.ROOT)
        if (normalizedEncodedPath.contains("%2f") || normalizedEncodedPath.contains("%5c")) return false
        val decodedPath = uri.path ?: return false
        if (decodedPath.contains('\\')) return false
        for (segment in decodedPath.split('/')) {
            if (segment == "..") return false
        }
        return true
    }

    private fun isInsideSessionAssetRoot(uri: Uri): Boolean {
        val path = uri.path ?: return false
        return path.startsWith(urlPathPrefix)
    }

    private fun entryUri(entryPath: String): String {
        return "$trustedOrigin$urlPathPrefix$entryPath"
    }

    private fun canonicalEntryPath(value: String): String {
        if (value.isEmpty() || value.length > MAX_ENTRY_PATH_LENGTH) invalidEntry()
        if (value.startsWith('/') || value.endsWith('/') || value.contains('\\')) invalidEntry()
        for (character in value) {
            if (!isAsciiEntryCharacter(character)) invalidEntry()
        }
        for (segment in value.split('/')) {
            if (segment.isEmpty() || segment == "." || segment == "..") invalidEntry()
        }
        return value
    }

    private fun invalidEntry(): Nothing {
        throw IllegalArgumentException("Android launcher entry is invalid.")
    }

    private fun isAsciiEntryCharacter(character: Char): Boolean {
        return character in 'a'..'z'
            || character in 'A'..'Z'
            || character in '0'..'9'
            || character in "._-/"
    }

    private fun forbiddenResponse(): WebResourceResponse {
        val body = "Arcane blocked this Android WebView request.".toByteArray(Charsets.UTF_8)
        return WebResourceResponse(
            "text/plain",
            "UTF-8",
            403,
            "Forbidden",
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(body)
        )
    }

    private class ScopedAssetsPathHandler(
        context: Context,
        root: String
    ) : WebViewAssetLoader.PathHandler {
        private val applicationContext = context.applicationContext
        private val assetRoot = canonicalAssetRoot(root)

        override fun handle(path: String): WebResourceResponse? {
            val relativePath = canonicalRequestPath(path) ?: return null
            val assetPath = "$assetRoot/$relativePath"
            return try {
                val stream = applicationContext.assets.open(assetPath)
                WebResourceResponse(
                    URLConnection.guessContentTypeFromName(assetPath) ?: "application/octet-stream",
                    if (isTextAsset(assetPath)) "UTF-8" else null,
                    stream
                )
            } catch (_: IOException) {
                null
            }
        }

        private companion object {
            fun canonicalAssetRoot(value: String): String {
                require(value.isNotEmpty() && !value.startsWith('/') && !value.endsWith('/') && !value.contains('\\'))
                require(value.split('/').none { segment -> segment.isEmpty() || segment == "." || segment == ".." })
                return value
            }

            fun canonicalRequestPath(value: String): String? {
                if (value.isEmpty() || value.startsWith('/') || value.endsWith('/') || value.contains('\\') || value.contains('%')) return null
                if (value.split('/').any { segment -> segment.isEmpty() || segment == "." || segment == ".." }) return null
                return value
            }

            fun isTextAsset(path: String): Boolean {
                return path.endsWith(".css")
                    || path.endsWith(".html")
                    || path.endsWith(".js")
                    || path.endsWith(".json")
                    || path.endsWith(".md")
                    || path.endsWith(".mjs")
                    || path.endsWith(".svg")
                    || path.endsWith(".txt")
            }
        }
    }

    private companion object {
        const val ASSET_PREFIX = "/arcane/"
        const val ROOT_ASSET_PREFIX = "/"
        const val MAX_ENTRY_PATH_LENGTH = 512
    }

    private enum class Lifecycle {
        NEW,
        CLOSING,
        INSTALLED,
        AUTHORITY_REVOKED,
        CLOSED
    }
}
