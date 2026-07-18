package os.arcane.host.android

import android.content.Intent
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ArcaneApplicationLaunchInstrumentedTest {
    @Test
    fun privateApplicationBridgeWorksWithoutShellWebView() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val intent = Intent(
            instrumentation.targetContext,
            ArcaneApplicationActivity::class.java
        ).putExtra(ArcaneApplicationActivity.EXTRA_APPLICATION_ID, "calculator")
        ActivityScenario.launch<ArcaneApplicationActivity>(intent).use { scenario ->
            val activity = AtomicReference<ArcaneApplicationActivity>()
            scenario.onActivity { launched -> activity.set(launched) }
            val webView = waitForApplicationWebView(activity.get())
            waitForLocation(
                webView,
                "https://calculator.arcane.invalid/calculator/index.html"
            )
            evaluate(
                webView,
                """
                    window.__arcaneTransportReadyReplay = null;
                    (function () {
                        var synchronous = true;
                        Arcane.events.when('transport.ready', function (value) {
                            window.__arcaneTransportReadyReplay = JSON.stringify({
                                completion: value,
                                synchronous: synchronous,
                                completed: Arcane.events.completed('transport.ready')
                            });
                        });
                        synchronous = false;
                    })();
                    null;
                """.trimIndent()
            )
            val readiness = JSONObject(waitForValue(webView, "window.__arcaneTransportReadyReplay"))
            assertFalse(readiness.getBoolean("synchronous"))
            assertTrue(readiness.getBoolean("completed"))
            val completion = readiness.getJSONObject("completion")
            assertEquals(2, completion.length())
            assertEquals("arcane/1", completion.getString("protocol"))
            assertEquals("android-webview", completion.getString("transport"))
        }
    }

    @Test
    fun privateApplicationBridgeWorksWhileShellWebViewRemainsAlive() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val monitor = instrumentation.addMonitor(ArcaneApplicationActivity::class.java.name, null, false)
        try {
            ActivityScenario.launch(ArcaneLauncherActivity::class.java).use { shellScenario ->
                val shellWebView = waitForShellWebView(shellScenario)
                waitForLocation(
                    shellWebView,
                    "https://appassets.androidplatform.net/arcane/shell/index.html"
                )
                val shellActivity = AtomicReference<ArcaneLauncherActivity>()
                shellScenario.onActivity { activity ->
                    shellActivity.set(activity)
                    activity.startActivity(
                        Intent(activity, ArcaneApplicationActivity::class.java)
                            .putExtra(ArcaneApplicationActivity.EXTRA_APPLICATION_ID, "calculator")
                    )
                }
                val launched = instrumentation.waitForMonitorWithTimeout(monitor, 10_000)
                assertTrue(launched is ArcaneApplicationActivity)
                val applicationActivity = launched as ArcaneApplicationActivity
                val webView = waitForApplicationWebView(applicationActivity)
                waitForLocation(
                    webView,
                    "https://calculator.arcane.invalid/calculator/index.html"
                )
                evaluate(
                    webView,
                    """
                        window.__arcaneTransportReadyReplay = null;
                        (function () {
                            var synchronous = true;
                            Arcane.events.when('transport.ready', function (value) {
                                window.__arcaneTransportReadyReplay = JSON.stringify({
                                    completion: value,
                                    synchronous: synchronous,
                                    completed: Arcane.events.completed('transport.ready')
                                });
                            });
                            synchronous = false;
                        })();
                        null;
                    """.trimIndent()
                )
                val readiness = JSONObject(waitForValue(webView, "window.__arcaneTransportReadyReplay"))
                assertFalse(readiness.getBoolean("synchronous"))
                assertTrue(readiness.getBoolean("completed"))
                val completion = readiness.getJSONObject("completion")
                assertEquals(2, completion.length())
                assertEquals("arcane/1", completion.getString("protocol"))
                assertEquals("android-webview", completion.getString("transport"))
                assertFalse(shellActivity.get().isDestroyed)
                evaluate(
                    webView,
                    """
                        window.__arcaneSameTaskIdentity = null;
                        Arcane.app.current().then(function (value) {
                            window.__arcaneSameTaskIdentity = JSON.stringify(value);
                        }).catch(function (error) {
                            window.__arcaneSameTaskIdentity = JSON.stringify({
                                error: String(error),
                                code: error && error.code ? error.code : null,
                                bridgeType: typeof arcaneAndroid,
                                postMessageType: typeof (arcaneAndroid && arcaneAndroid.postMessage)
                            });
                        });
                        null;
                    """.trimIndent()
                )
                val identity = JSONObject(waitForValue(webView, "window.__arcaneSameTaskIdentity"))
                if (identity.has("error")) fail("Same-task Calculator bridge failed: $identity")
                assertEquals("calculator", identity.getString("id"))
                instrumentation.runOnMainSync { applicationActivity.finish() }
                waitForDestroyed(applicationActivity)
            }
        } finally {
            instrumentation.removeMonitor(monitor)
        }
    }

    @Test
    fun shellLaunchesCalculatorInAnIsolatedActivityOriginAndSession() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val monitor = instrumentation.addMonitor(ArcaneApplicationActivity::class.java.name, null, false)
        try {
            ActivityScenario.launch(ArcaneLauncherActivity::class.java).use { scenario ->
                val shellWebView = waitForShellWebView(scenario)
                waitForLocation(
                    shellWebView,
                    "https://appassets.androidplatform.net/arcane/shell/index.html"
                )
                evaluate(
                    shellWebView,
                    """
                        window.__arcaneLaunchResult = null;
                        Arcane.applications.launch('calculator').then(function (value) {
                            window.__arcaneLaunchResult = JSON.stringify(value);
                        }).catch(function (error) {
                            window.__arcaneLaunchResult = JSON.stringify({
                                error: String(error),
                                code: error && error.code ? error.code : null
                            });
                        });
                        null;
                    """.trimIndent()
                )
                val launchResult = JSONObject(waitForValue(shellWebView, "window.__arcaneLaunchResult"))
                if (launchResult.has("error")) fail("Android application launch failed: $launchResult")
                assertEquals("calculator", launchResult.getString("id"))
                assertTrue(launchResult.getBoolean("accepted"))

                val launched = instrumentation.waitForMonitorWithTimeout(monitor, 10_000)
                assertTrue(launched is ArcaneApplicationActivity)
                val applicationActivity = launched as ArcaneApplicationActivity
                val applicationWebView = waitForApplicationWebView(applicationActivity)
                assertNotSame(shellWebView, applicationWebView)
                assertEquals("calculator", applicationActivity.hostedApplicationId)
                assertEquals("Arcane Calculator", applicationActivity.title.toString())
                waitForLocation(
                    applicationWebView,
                    "https://calculator.arcane.invalid/calculator/index.html"
                )
                evaluate(
                    applicationWebView,
                    """
                        window.__arcaneApplicationIdentity = null;
                        window.__arcaneDeniedLaunch = null;
                        Arcane.app.current().then(function (value) {
                            window.__arcaneApplicationIdentity = JSON.stringify(value);
                        }).catch(function (error) {
                            window.__arcaneApplicationIdentity = JSON.stringify({
                                error: String(error),
                                code: error && error.code ? error.code : null,
                                technicalMessage: error && error.technicalMessage ? error.technicalMessage : null
                            });
                        });
                        Arcane.applications.launch('boss').then(function (value) {
                            window.__arcaneDeniedLaunch = JSON.stringify(value);
                        }).catch(function (error) {
                            window.__arcaneDeniedLaunch = JSON.stringify({
                                code: error && error.code ? error.code : null
                            });
                        });
                        null;
                    """.trimIndent()
                )
                val identity = JSONObject(waitForValue(applicationWebView, "window.__arcaneApplicationIdentity"))
                if (identity.has("error")) fail("Calculator identity bridge call failed: $identity")
                assertEquals("calculator", identity.getString("id"))
                assertEquals("app", identity.getString("type"))
                assertEquals("calculator/index.html", identity.getString("entry"))
                val denied = JSONObject(waitForValue(applicationWebView, "window.__arcaneDeniedLaunch"))
                assertEquals("ANDROID_CAPABILITY_DENIED", denied.getString("code"))

                instrumentation.runOnMainSync { applicationActivity.finish() }
                waitForDestroyed(applicationActivity)
                val closeResult = applicationActivity.closeResult
                assertNotNull(closeResult)
                assertTrue(closeResult!!.authorityRevoked)
                assertTrue(closeResult.destroyed)
                assertFalse(closeResult.retryable)
                assertTrue(closeResult.failures.isEmpty())

                evaluate(
                    shellWebView,
                    """
                        window.__arcaneShellIdentityAfterReturn = null;
                        Arcane.app.current().then(function (value) {
                            window.__arcaneShellIdentityAfterReturn = JSON.stringify(value);
                        });
                        null;
                    """.trimIndent()
                )
                val shellIdentity = JSONObject(
                    waitForValue(shellWebView, "window.__arcaneShellIdentityAfterReturn")
                )
                assertEquals("shell", shellIdentity.getString("id"))
            }
        } finally {
            instrumentation.removeMonitor(monitor)
        }
    }

    private fun waitForShellWebView(
        scenario: ActivityScenario<ArcaneLauncherActivity>
    ): WebView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val reference = AtomicReference<WebView?>()
            scenario.onActivity { activity -> reference.set(activity.hostedWebView) }
            val webView = reference.get()
            if (webView != null) return webView
            Thread.sleep(50)
        }
        throw AssertionError("The Arcane Shell WebView was not created.")
    }

    private fun waitForApplicationWebView(activity: ArcaneApplicationActivity): WebView {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val reference = AtomicReference<WebView?>()
            instrumentation.runOnMainSync { reference.set(activity.hostedWebView) }
            val webView = reference.get()
            if (webView != null) return webView
            Thread.sleep(50)
        }
        throw AssertionError("The launched Arcane application WebView was not created.")
    }

    private fun waitForLocation(webView: WebView, expected: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            if (evaluate(webView, "location.href === '$expected' && document.readyState === 'complete'") == "true") return
            Thread.sleep(100)
        }
        throw AssertionError("Arcane did not finish loading $expected; current=${currentUrl(webView)}")
    }

    private fun waitForValue(webView: WebView, expression: String): String {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            val value = evaluate(webView, expression)
            if (value != null) return value
            Thread.sleep(100)
        }
        val diagnostics = evaluate(
            webView,
            "JSON.stringify({" +
                "location: location.href," +
                "readyState: document.readyState," +
                "arcaneType: typeof Arcane," +
                "scripts: Array.from(document.scripts).map(function (script) { return script.src; })," +
                "resources: performance.getEntriesByType('resource').map(function (entry) { return entry.name; })" +
                "})"
        )
        throw AssertionError("The Arcane Android bridge did not return $expression: $diagnostics")
    }

    private fun waitForDestroyed(activity: ArcaneApplicationActivity) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            if (activity.isDestroyed) return
            Thread.sleep(50)
        }
        throw AssertionError("The launched Arcane application Activity was not destroyed.")
    }

    private fun currentUrl(webView: WebView): String? {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val reference = AtomicReference<String?>()
        instrumentation.runOnMainSync { reference.set(webView.url) }
        return reference.get()
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
}
