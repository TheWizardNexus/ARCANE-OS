package os.arcane.host.android

import android.net.Uri
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.ServiceWorkerController
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.annotation.UiThread
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.util.Locale

internal class ArcaneWebViewHostController(
    private val hostSession: ArcaneAndroidHostSession
) {
    private val allowedEntry = canonicalEntryPath(hostSession.entry)
    private val allowedEntryUri = entryUri(allowedEntry)
    private val assetLoader = WebViewAssetLoader.Builder()
        .setHttpAllowed(false)
        .addPathHandler(ASSET_PREFIX, WebViewAssetLoader.AssetsPathHandler(hostSession.applicationContext))
        .build()
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
        externalOpenProvider: ArcaneWebViewBridge.ExternalOpenProvider,
        networkStatusProvider: ArcaneWebViewBridge.NetworkStatusProvider
    ): InstallResult {
        if (lifecycle != Lifecycle.NEW) {
            return InstallResult(false, lifecycle != Lifecycle.CLOSED, null, "CONTROLLER_ALREADY_USED")
        }
        val currentLooper = Looper.myLooper()
            ?: return InstallResult(false, false, null, "INSTALL_THREAD_UNAVAILABLE")
        hardenSettings(webView.settings)
        hardenServiceWorkers()
        installedWebView = webView
        installedLooper = currentLooper
        lifecycle = Lifecycle.CLOSING
        val bridgeInstalled = try {
            ArcaneWebViewBridge.install(
                webView,
                allowedEntry,
                hostSession,
                hostSession,
                hostSession,
                hostSession,
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

    private fun hardenServiceWorkers() {
        val settings = ServiceWorkerController.getInstance().serviceWorkerWebSettings
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.blockNetworkLoads = true
    }

    private inner class Client : WebViewClientCompat() {
        private var blankingUntrustedNavigation = false

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            return !isAllowedEntry(request.url)
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            if (!isTrustedAssetUri(uri)) {
                return forbiddenResponse()
            }
            if (!request.method.equals("GET", ignoreCase = false) || !hasSafeAssetPath(uri)) {
                return forbiddenResponse()
            }
            if (request.isForMainFrame && !isAllowedEntry(uri)) {
                return forbiddenResponse()
            }
            return assetLoader.shouldInterceptRequest(uri) ?: forbiddenResponse()
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            if (blankingUntrustedNavigation && url == BLANK_URI) {
                blankingUntrustedNavigation = false
                return
            }
            val uri = try {
                Uri.parse(url)
            } catch (_: Exception) {
                null
            }
            if (uri != null && isAllowedEntry(uri)) return
            view.stopLoading()
            blankingUntrustedNavigation = true
            view.loadUrl(BLANK_URI)
        }
    }

    private fun isAllowedEntry(uri: Uri): Boolean {
        if (!isTrustedAssetUri(uri) || !hasSafeAssetPath(uri)) return false
        if (uri.query != null || uri.fragment != null) return false
        return uri.toString() == allowedEntryUri
    }

    private fun isTrustedAssetUri(uri: Uri): Boolean {
        return uri.scheme == "https"
            && uri.host == TRUSTED_HOST
            && uri.port == -1
            && uri.userInfo == null
            && uri.path?.startsWith(ASSET_PREFIX) == true
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

    private fun entryUri(entryPath: String): String {
        return "https://$TRUSTED_HOST$ASSET_PREFIX$entryPath"
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

    private companion object {
        const val TRUSTED_HOST = "appassets.androidplatform.net"
        const val ASSET_PREFIX = "/arcane/"
        const val BLANK_URI = "about:blank"
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
