package os.arcane.host.android

import android.app.Instrumentation
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.Profile
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReferenceArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ArcaneWebViewProfileCoexistenceInstrumentedTest {
    @Test
    fun twoWebViewsRenderConcurrently() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val mode = requestedMode()
        val serviceWorkerHardening = requestedServiceWorkerHardening()
        val bridgeListener = requestedBridgeListener()
        val stageSequence = AtomicInteger()
        val recordStage = { stage: String ->
            recordStage(instrumentation, stageSequence, mode, stage)
        }
        recordStage("test-started")
        recordStage("service-worker-hardening:$serviceWorkerHardening")
        recordStage("bridge-listener:$bridgeListener")
        assertTrue(
            "This diagnostic requires WebView multi-profile support.",
            WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
        )
        recordStage("multi-profile-supported")

        val pageFinished = CountDownLatch(WEBVIEW_COUNT)
        val visuallyComplete = CountDownLatch(WEBVIEW_COUNT)
        val observedUrls = AtomicReferenceArray<String?>(WEBVIEW_COUNT)
        ActivityScenario.launch(ArcaneWebViewProfileProbeActivity::class.java).use { scenario ->
            recordStage("activity-launched")
            scenario.onActivity { activity ->
                for (index in 0 until WEBVIEW_COUNT) {
                    val label = "webview-${index + 1}"
                    recordStage("$label-construction-started")
                    val webView = WebView(activity)
                    recordStage("$label-constructed")

                    val requestedProfile = mode.profileName(index)
                    if (requestedProfile != null) {
                        recordStage("$label-profile-assignment-started")
                        WebViewCompat.setProfile(webView, requestedProfile)
                        recordStage("$label-profile-assignment-finished")
                    } else {
                        recordStage("$label-profile-assignment-default")
                    }
                    val expectedProfile = requestedProfile ?: Profile.DEFAULT_PROFILE_NAME
                    val actualProfile = WebViewCompat.getProfile(webView).name
                    assertEquals(expectedProfile, actualProfile)
                    recordStage("$label-profile-ready:$actualProfile")
                    if (serviceWorkerHardening) {
                        recordStage("$label-service-worker-hardening-started")
                        val serviceWorkerSettings = WebViewCompat.getProfile(webView)
                            .serviceWorkerController
                            .serviceWorkerWebSettings
                        serviceWorkerSettings.allowFileAccess = false
                        serviceWorkerSettings.allowContentAccess = false
                        serviceWorkerSettings.blockNetworkLoads = true
                        recordStage("$label-service-worker-hardening-finished")
                    }
                    if (bridgeListener) {
                        recordStage("$label-bridge-listener-started")
                        WebViewCompat.addWebMessageListener(
                            webView,
                            ArcaneWebViewBridge.BRIDGE_NAME,
                            setOf(PROBE_ORIGIN),
                            NoOpWebMessageListener
                        )
                        recordStage("$label-bridge-listener-finished")
                    }

                    webView.settings.javaScriptEnabled = true
                    webView.webViewClient = CompletionClient(
                        index,
                        observedUrls,
                        pageFinished,
                        visuallyComplete,
                        recordStage
                    )
                    recordStage("$label-configured")
                    activity.attachProbeWebView(webView)
                    recordStage("$label-attached")
                    webView.loadDataWithBaseURL(
                        PROBE_URL,
                        PROBE_DOCUMENT,
                        "text/html",
                        "UTF-8",
                        null
                    )
                    recordStage("$label-load-requested")
                }
            }

            assertTrue(
                "The two WebView documents did not finish before the diagnostic timeout.",
                pageFinished.await(CALLBACK_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            )
            recordStage("both-pages-finished")
            for (index in 0 until WEBVIEW_COUNT) {
                assertEquals(PROBE_URL, observedUrls.get(index))
            }
            assertTrue(
                "The two WebViews did not reach visual completion before the diagnostic timeout.",
                visuallyComplete.await(CALLBACK_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            )
            recordStage("both-webviews-visually-complete")

            scenario.onActivity { activity ->
                activity.destroyProbeWebViews(
                    recordStage = recordStage,
                    beforeDestroy = if (bridgeListener) {
                        { webView, label ->
                            recordStage("$label-bridge-listener-removal-started")
                            WebViewCompat.removeWebMessageListener(
                                webView,
                                ArcaneWebViewBridge.BRIDGE_NAME
                            )
                            recordStage("$label-bridge-listener-removal-finished")
                        }
                    } else {
                        null
                    }
                )
            }
            recordStage("reverse-order-teardown-complete")
        }
        recordStage("test-finished")
    }

    private fun requestedMode(): ProfileMode {
        val requested = InstrumentationRegistry.getArguments().getString(PROFILE_MODE_ARGUMENT)
        return ProfileMode.values().firstOrNull { mode -> mode.argumentValue == requested }
            ?: throw AssertionError(
                "Pass -e $PROFILE_MODE_ARGUMENT default or -e $PROFILE_MODE_ARGUMENT distinct."
            )
    }

    private fun requestedServiceWorkerHardening(): Boolean {
        return when (
            val requested = InstrumentationRegistry.getArguments()
                .getString(SERVICE_WORKER_HARDENING_ARGUMENT)
        ) {
            null, "false" -> false
            "true" -> true
            else -> throw AssertionError(
                "Pass -e $SERVICE_WORKER_HARDENING_ARGUMENT true or false; received $requested."
            )
        }
    }

    private fun requestedBridgeListener(): Boolean {
        return when (
            val requested = InstrumentationRegistry.getArguments()
                .getString(BRIDGE_LISTENER_ARGUMENT)
        ) {
            null, "false" -> false
            "true" -> true
            else -> throw AssertionError(
                "Pass -e $BRIDGE_LISTENER_ARGUMENT true or false; received $requested."
            )
        }
    }

    private fun recordStage(
        instrumentation: Instrumentation,
        sequence: AtomicInteger,
        mode: ProfileMode,
        stage: String
    ) {
        val record = "${sequence.incrementAndGet()}:mode=${mode.argumentValue}:$stage"
        Log.i(LOG_TAG, record)
        instrumentation.sendStatus(
            0,
            Bundle().apply {
                putString(Instrumentation.REPORT_KEY_STREAMRESULT, "$LOG_TAG $record\n")
            }
        )
    }

    private class CompletionClient(
        private val index: Int,
        private val observedUrls: AtomicReferenceArray<String?>,
        private val pageFinished: CountDownLatch,
        private val visuallyComplete: CountDownLatch,
        private val recordStage: (String) -> Unit
    ) : WebViewClientCompat() {
        private val completionRequested = AtomicBoolean()

        override fun onPageFinished(view: WebView, url: String?) {
            if (!completionRequested.compareAndSet(false, true)) return
            val label = "webview-${index + 1}"
            observedUrls.set(index, url)
            recordStage("$label-page-finished:$url")
            pageFinished.countDown()
            WebViewCompat.postVisualStateCallback(
                view,
                (index + 1).toLong(),
                object : WebViewCompat.VisualStateCallback {
                    override fun onComplete(requestId: Long) {
                        recordStage("$label-visual-state-complete:$requestId")
                        visuallyComplete.countDown()
                    }
                }
            )
        }
    }

    private object NoOpWebMessageListener : WebViewCompat.WebMessageListener {
        override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: Uri,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy
        ) = Unit
    }

    private enum class ProfileMode(val argumentValue: String) {
        DEFAULT("default") {
            override fun profileName(index: Int): String? {
                requireValidIndex(index)
                return null
            }
        },
        DISTINCT("distinct") {
            override fun profileName(index: Int): String {
                requireValidIndex(index)
                return DISTINCT_PROFILE_NAMES[index]
            }
        };

        abstract fun profileName(index: Int): String?

        protected fun requireValidIndex(index: Int) {
            require(index in 0 until WEBVIEW_COUNT)
        }
    }

    private companion object {
        const val LOG_TAG = "ArcaneProfileProbe"
        const val PROFILE_MODE_ARGUMENT = "arcaneProfileMode"
        const val SERVICE_WORKER_HARDENING_ARGUMENT = "arcaneServiceWorkerHardening"
        const val BRIDGE_LISTENER_ARGUMENT = "arcaneBridgeListener"
        const val WEBVIEW_COUNT = 2
        const val CALLBACK_TIMEOUT_SECONDS = 30L
        const val PROBE_URL = "https://arcane-profile-probe.invalid/index.html"
        const val PROBE_ORIGIN = "https://arcane-profile-probe.invalid"
        val DISTINCT_PROFILE_NAMES = arrayOf(
            "arcane-profile-probe-one",
            "arcane-profile-probe-two"
        )
        val PROBE_DOCUMENT =
            """
                <!doctype html>
                <html lang="en">
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <title>ARCANE WebView profile diagnostic</title>
                </head>
                <body>
                    <main>ARCANE WebView profile diagnostic</main>
                </body>
                </html>
            """.trimIndent()
    }
}
