package os.arcane.host.android

import android.app.Activity
import android.os.Bundle
import android.webkit.WebView

class ArcanePackagedApplicationActivity : Activity() {
    private val activityHost = ArcaneActivityHost(this)
    internal val hostedWebView: WebView?
        get() = activityHost.hostedWebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val hostSession = try {
            ArcaneAndroidHostSession.createApplication(this, BuildConfig.ARCANE_APP_ID)
        } catch (_: Exception) {
            activityHost.showFailure("ANDROID_APPLICATION_DESCRIPTOR_INVALID")
            return
        }
        title = hostSession.currentApplicationIdentity().displayName
        activityHost.start(hostSession)
    }

    override fun onDestroy() {
        activityHost.close()
        super.onDestroy()
    }
}
