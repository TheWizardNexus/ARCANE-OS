package os.arcane.host.android

import android.app.Activity
import android.os.Bundle
import android.webkit.WebView

class ArcaneLauncherActivity : Activity() {
    private val activityHost = ArcaneActivityHost(this)
    internal val hostedWebView: WebView?
        get() = activityHost.hostedWebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val hostSession = try {
            ArcaneAndroidHostSession.createShell(this)
        } catch (_: Exception) {
            activityHost.showFailure("ANDROID_SHELL_DESCRIPTOR_INVALID")
            return
        }
        activityHost.start(hostSession)
    }

    override fun onDestroy() {
        activityHost.close()
        super.onDestroy()
    }
}
