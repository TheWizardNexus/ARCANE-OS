package os.arcane.host.android

import android.app.Activity
import android.content.Intent
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.TextView

internal class ArcaneActivityHost(private val activity: Activity) {
    internal var hostedWebView: WebView? = null
        private set
    private var controller: ArcaneWebViewHostController? = null

    internal fun start(hostSession: ArcaneAndroidHostSession): Boolean {
        val webView = WebView(activity)
        val systemAdapter = ArcaneAndroidSystemAdapter(activity)
        val hostController = ArcaneWebViewHostController(hostSession)
        val launchProvider = ArcaneWebViewBridge.ApplicationLaunchProvider { id ->
            launchApplication(id)
        }
        val result = hostController.install(webView, launchProvider, systemAdapter, systemAdapter)
        if (!result.installed) {
            showFailure(result.errorCode ?: "ANDROID_LAUNCHER_INSTALL_FAILED")
            return false
        }
        hostedWebView = webView
        controller = hostController
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
        val result = if (webView != null && hostController != null) {
            hostController.close(webView)
        } else {
            null
        }
        hostedWebView = null
        controller = null
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
            ArcaneAndroidApplicationCatalog(activity).readSnapshot().requireLaunchDescriptor(id)
            val intent = Intent(activity, ArcaneApplicationActivity::class.java)
                .putExtra(ArcaneApplicationActivity.EXTRA_APPLICATION_ID, id)
            activity.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }
}
