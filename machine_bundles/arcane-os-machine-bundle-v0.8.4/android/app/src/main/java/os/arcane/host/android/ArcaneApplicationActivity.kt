package os.arcane.host.android

import android.app.Activity
import android.os.Bundle
import android.webkit.WebView

class ArcaneApplicationActivity : Activity() {
    private val activityHost = ArcaneActivityHost(this)
    internal val hostedWebView: WebView?
        get() = activityHost.hostedWebView
    internal var hostedApplicationId: String? = null
        private set
    internal var closeResult: ArcaneWebViewHostController.CloseResult? = null
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val applicationId = intent?.getStringExtra(EXTRA_APPLICATION_ID)
        if (applicationId == null) {
            activityHost.showFailure("ANDROID_APPLICATION_ID_MISSING")
            return
        }
        val hostSession = try {
            ArcaneAndroidHostSession.createApplication(this, applicationId)
        } catch (_: Exception) {
            activityHost.showFailure("ANDROID_APPLICATION_DESCRIPTOR_INVALID")
            return
        }
        hostedApplicationId = applicationId
        title = hostSession.currentApplicationIdentity().displayName
        activityHost.start(hostSession)
    }

    override fun onDestroy() {
        closeResult = activityHost.close()
        hostedApplicationId = null
        super.onDestroy()
    }

    internal companion object {
        const val EXTRA_APPLICATION_ID = "os.arcane.host.android.APPLICATION_ID"
    }
}
