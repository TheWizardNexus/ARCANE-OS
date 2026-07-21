package os.arcane.host.android

import android.app.Activity
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.TextView

internal class ArcaneActivityHost(private val activity: Activity) {
    internal var hostedWebView: WebView? = null
        private set
    private var controller: ArcaneWebViewHostController? = null
    private var terminalProvider: ArcaneAndroidTerminalProvider? = null

    internal fun start(hostSession: ArcaneAndroidHostSession): Boolean {
        val webView = WebView(activity)
        val systemAdapter = ArcaneAndroidSystemAdapter(activity)
        val hostController = ArcaneWebViewHostController(hostSession)
        val applicationId = hostSession.currentApplicationIdentity().id
        val terminal = if (applicationId == "terminal") ArcaneAndroidTerminalProvider(activity) else null
        val launchProvider = ArcaneWebViewBridge.ApplicationLaunchProvider { id ->
            launchApplication(id)
        }
        val result = hostController.install(webView, launchProvider, systemAdapter, systemAdapter, terminal)
        if (!result.installed) {
            showFailure(result.errorCode ?: "ANDROID_LAUNCHER_INSTALL_FAILED")
            return false
        }
        hostedWebView = webView
        controller = hostController
        terminalProvider = terminal
        activity.setContentView(
            webView,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        if (!hostController.loadEntry(webView)) {
            close()
            showFailure("ANDROID_LAUNCHER_LOAD_FAILED")
            return false
        }
        return true
    }

    internal fun close(): ArcaneWebViewHostController.CloseResult? {
        val webView = hostedWebView
        val hostController = controller
        terminalProvider?.closeAll()
        val result = if (webView != null && hostController != null) {
            hostController.close(webView)
        } else {
            null
        }
        hostedWebView = null
        controller = null
        terminalProvider = null
        return result
    }

    internal fun showFailure(code: String) {
        val message = TextView(activity)
        message.text = "Arcane OS could not open this application. Error: $code. Go back and try again."
        message.contentDescription = message.text
        message.isFocusable = true
        activity.setContentView(message)
        message.requestFocus()
    }

    private fun launchApplication(id: String): Boolean {
        return try {
            val descriptor = ArcaneAndroidApplicationCatalog(activity)
                .readInstalledSnapshot()
                .requireLaunchDescriptor(id)
            val packageName = descriptor.packageName
                ?: throw IllegalArgumentException("Android application package identity is unavailable.")
            val intent = activity.packageManager.getLaunchIntentForPackage(packageName)
                ?: throw IllegalArgumentException("Android application package is not launchable.")
            activity.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }
}
