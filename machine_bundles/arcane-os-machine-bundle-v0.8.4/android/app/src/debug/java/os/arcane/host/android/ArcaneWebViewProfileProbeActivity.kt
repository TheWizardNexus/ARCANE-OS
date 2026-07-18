package os.arcane.host.android

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.LinearLayout

class ArcaneWebViewProfileProbeActivity : Activity() {
    private lateinit var probeContainer: LinearLayout
    private val probeWebViews = mutableListOf<WebView>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        probeContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        setContentView(
            probeContainer,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
    }

    internal fun attachProbeWebView(webView: WebView) {
        require(webView.parent == null)
        probeWebViews.add(webView)
        probeContainer.addView(
            webView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1.0f
            )
        )
    }

    internal fun destroyProbeWebViews(
        recordStage: (String) -> Unit = ::recordFallbackStage,
        beforeDestroy: ((WebView, String) -> Unit)? = null
    ) {
        while (probeWebViews.isNotEmpty()) {
            val index = probeWebViews.lastIndex
            val webView = probeWebViews.removeAt(index)
            val label = "webview-${index + 1}"
            recordStage("$label-teardown-started")
            beforeDestroy?.invoke(webView, label)
            webView.stopLoading()
            probeContainer.removeView(webView)
            webView.destroy()
            recordStage("$label-destroyed")
        }
    }

    override fun onDestroy() {
        destroyProbeWebViews()
        super.onDestroy()
    }

    private fun recordFallbackStage(stage: String) {
        Log.i(LOG_TAG, stage)
    }

    private companion object {
        const val LOG_TAG = "ArcaneProfileProbe"
    }
}
