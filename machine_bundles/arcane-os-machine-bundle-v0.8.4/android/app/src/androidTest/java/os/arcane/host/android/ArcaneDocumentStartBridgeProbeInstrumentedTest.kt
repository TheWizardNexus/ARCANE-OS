package os.arcane.host.android

import android.content.Intent
import android.os.Build
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ArcaneDocumentStartBridgeProbeInstrumentedTest {
    @Test
    fun exactApplicationOriginHasBridgeBeforePackagedScriptsRunOnApi36WebView133() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val monitor = instrumentation.addMonitor(ArcaneApplicationActivity::class.java.name, null, false)
        val launchedActivity = AtomicReference<ArcaneApplicationActivity?>()
        val scriptHandler = AtomicReference<ScriptHandler?>()
        try {
            ActivityScenario.launch(ArcaneLauncherActivity::class.java).use { shellScenario ->
                shellScenario.onActivity { activity ->
                    activity.startActivity(
                        Intent(activity, ArcaneApplicationActivity::class.java)
                            .putExtra(ArcaneApplicationActivity.EXTRA_APPLICATION_ID, APPLICATION_ID)
                    )
                }
                val launched = instrumentation.waitForMonitorWithTimeout(monitor, 10_000)
                assertTrue(launched is ArcaneApplicationActivity)
                val applicationActivity = launched as ArcaneApplicationActivity
                launchedActivity.set(applicationActivity)
                val webView = waitForWebView(applicationActivity)
                waitForLocation(webView, APPLICATION_URL)

                assertEquals("This diagnostic must run on Android API 36.", 36, Build.VERSION.SDK_INT)
                val webViewVersion = WebViewCompat.getCurrentWebViewPackage(
                    instrumentation.targetContext
                )?.versionName.orEmpty()
                assertTrue(
                    "This diagnostic must run on WebView 133; current=$webViewVersion",
                    webViewVersion.startsWith("133.")
                )
                assertTrue(
                    "The WebView document-start-script feature is unavailable.",
                    WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
                )

                instrumentation.runOnMainSync {
                    scriptHandler.set(
                        WebViewCompat.addDocumentStartJavaScript(
                            webView,
                            DOCUMENT_START_PROBE,
                            setOf(APPLICATION_ORIGIN)
                        )
                    )
                    webView.reload()
                }

                val marker = JSONObject(waitForMarker(webView))
                waitForLocation(webView, APPLICATION_URL)
                assertEquals(APPLICATION_ORIGIN, marker.getString("origin"))
                assertEquals(APPLICATION_URL, marker.getString("href"))
                assertEquals("loading", marker.getString("readyState"))
                assertEquals(0, marker.getInt("parsedScriptCount"))
                assertEquals("undefined", marker.getString("arcaneType"))
                assertEquals("object", marker.getString("bridgeType"))
                assertEquals("function", marker.getString("postMessageType"))
                assertTrue(marker.getBoolean("bridgeReady"))
            }
        } finally {
            val handler = scriptHandler.get()
            if (handler != null) instrumentation.runOnMainSync { handler.remove() }
            val activity = launchedActivity.get()
            if (activity != null && !activity.isDestroyed) {
                instrumentation.runOnMainSync { activity.finish() }
            }
            instrumentation.removeMonitor(monitor)
        }
    }

    private fun waitForWebView(activity: ArcaneApplicationActivity): WebView {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val reference = AtomicReference<WebView?>()
            instrumentation.runOnMainSync { reference.set(activity.hostedWebView) }
            val webView = reference.get()
            if (webView != null) return webView
            Thread.sleep(50)
        }
        throw AssertionError("The Calculator WebView was not created.")
    }

    private fun waitForLocation(webView: WebView, expected: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            if (evaluate(webView, "location.href === '$expected' && document.readyState === 'complete'") == "true") return
            Thread.sleep(100)
        }
        throw AssertionError("Calculator did not finish loading $expected.")
    }

    private fun waitForMarker(webView: WebView): String {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            val value = evaluate(webView, "JSON.stringify(globalThis.$PROBE_MARKER)")
            if (value != null) return value
            Thread.sleep(100)
        }
        val diagnostics = evaluate(
            webView,
            "JSON.stringify({" +
                "location:location.href," +
                "readyState:document.readyState," +
                "bridgeType:typeof globalThis.arcaneAndroid," +
                "postMessageType:typeof (globalThis.arcaneAndroid && globalThis.arcaneAndroid.postMessage)," +
                "arcaneType:typeof globalThis.Arcane" +
                "})"
        )
        fail("The exact-origin document-start marker did not run: $diagnostics")
        throw AssertionError("Unreachable")
    }

    private fun evaluate(webView: WebView, script: String): String? {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val result = AtomicReference<String?>()
        val callback = CountDownLatch(1)
        instrumentation.runOnMainSync {
            webView.evaluateJavascript(script) { encoded ->
                if (encoded != "null") result.set(JSONArray("[$encoded]").getString(0))
                callback.countDown()
            }
        }
        assertTrue("JavaScript callback timed out.", callback.await(10, TimeUnit.SECONDS))
        return result.get()
    }

    private companion object {
        const val APPLICATION_ID = "calculator"
        const val APPLICATION_ORIGIN = "https://calculator.arcane.invalid"
        const val APPLICATION_URL = "$APPLICATION_ORIGIN/calculator/index.html"
        const val PROBE_MARKER = "__arcaneAndroidDocumentStartBridgeProbe20260718"
        val DOCUMENT_START_PROBE =
            """
                (function () {
                    var bridge = globalThis.arcaneAndroid;
                    Object.defineProperty(globalThis, '$PROBE_MARKER', {
                        value: Object.freeze({
                            bridgeReady: typeof bridge === 'object' && typeof bridge.postMessage === 'function',
                            bridgeType: typeof bridge,
                            postMessageType: typeof (bridge && bridge.postMessage),
                            arcaneType: typeof globalThis.Arcane,
                            origin: location.origin,
                            href: location.href,
                            readyState: document.readyState,
                            parsedScriptCount: document.scripts.length
                        }),
                        configurable: false,
                        enumerable: false,
                        writable: false
                    });
                })();
            """.trimIndent()
    }
}
