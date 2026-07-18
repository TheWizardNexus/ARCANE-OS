package os.arcane.host.android

import android.webkit.WebSettings
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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ArcaneLauncherInstrumentedTest {
    @Test
    fun shellLoadsThroughHardenedWebViewAndAnswersCoreBridgeCalls() {
        ActivityScenario.launch(ArcaneLauncherActivity::class.java).use { scenario ->
            waitForDocument(scenario)
            scenario.onActivity { activity ->
                val webView = activity.hostedWebView
                assertNotNull(webView)
                assertEquals(
                    "https://appassets.androidplatform.net/arcane/shell/index.html",
                    webView?.url
                )
                assertFalse(webView!!.settings.allowFileAccess)
                assertFalse(webView.settings.allowContentAccess)
                assertFalse(webView.settings.javaScriptCanOpenWindowsAutomatically)
                assertEquals(
                    WebSettings.MIXED_CONTENT_NEVER_ALLOW,
                    webView.settings.mixedContentMode
                )
            }

            evaluate(
                scenario,
                """
                    window.__arcaneAndroidTestResult = null;
                    async function runArcaneAndroidTest() {
                        try {
                            if (typeof Arcane === 'undefined') {
                                const sourceResponse = await fetch(
                                    'https://appassets.androidplatform.net/arcane/shared/arcane-api.js'
                                );
                                const source = await sourceResponse.text();
                                let evaluationError = null;
                                try {
                                    (0, eval)(source);
                                } catch (error) {
                                    evaluationError = String(error);
                                }
                                window.__arcaneAndroidTestResult = JSON.stringify({
                                    error: 'Arcane is not defined',
                                    sourceStatus: sourceResponse.status,
                                    sourceLength: source.length,
                                    location: location.href,
                                    baseUri: document.baseURI,
                                    scriptSource: document.querySelector('script[src]')
                                        ? document.querySelector('script[src]').src
                                        : null,
                                    evaluationError: evaluationError
                                });
                                return;
                            }
                            const values = await Promise.all([
                                Arcane.system.ping(),
                                Arcane.version.current(),
                                Arcane.user.current(),
                                Arcane.platform.status(),
                                Arcane.app.current()
                            ]);
                            window.__arcaneAndroidTestResult = JSON.stringify(values);
                        } catch (error) {
                            window.__arcaneAndroidTestResult = JSON.stringify({ error: String(error) });
                        }
                    }
                    runArcaneAndroidTest();
                    null;
                """.trimIndent()
            )
            val result = waitForJavaScriptValue(scenario, "window.__arcaneAndroidTestResult")
            if (result.startsWith("{")) {
                fail("Arcane bootstrap diagnostics: $result")
            }
            val values = JSONArray(result)
            assertTrue(values.getJSONObject(0).getBoolean("ok"))
            assertEquals("0.8.4", values.getString(1))
            val user = values.getJSONObject(2)
            assertEquals("local-session", user.getString("identityKind"))
            assertTrue(user.isNull("username"))
            assertTrue(user.isNull("accountName"))
            assertEquals("Local user", user.getString("displayName"))
            assertEquals("android", user.getString("source"))
            assertEquals("android", values.getJSONObject(3).getString("platform"))
            assertEquals("android-webview", values.getJSONObject(3).getString("adapter"))
            assertEquals(
                "application-sandbox",
                values.getJSONObject(3).getJSONObject("permissions").getString("level")
            )
            assertEquals("shell", values.getJSONObject(4).getString("id"))
            evaluate(
                scenario,
                """
                    window.__arcaneAndroidCatalogResult = null;
                    async function runArcaneAndroidCatalogTest() {
                        try {
                            window.__arcaneAndroidCatalogResult = JSON.stringify(
                                await Arcane.applications.list()
                            );
                        } catch (error) {
                            window.__arcaneAndroidCatalogResult = JSON.stringify({ error: String(error) });
                        }
                    }
                    runArcaneAndroidCatalogTest();
                    null;
                """.trimIndent()
            )
            val catalog = JSONObject(
                waitForJavaScriptValue(scenario, "window.__arcaneAndroidCatalogResult")
            )
            assertTrue(catalog.getBoolean("verified"))
            assertEquals("unsigned-local-test", catalog.getString("securityMode"))
            assertTrue(catalog.isNull("publisherTrustSource"))
            assertTrue(catalog.isNull("revocationStatus"))
            assertEquals(17, catalog.getJSONArray("applications").length())
            assertEquals("boss", catalog.getJSONArray("applications").getJSONObject(0).getString("id"))
            waitForJavaScriptTrue(
                scenario,
                "document.querySelectorAll('.app-card').length === 17" +
                    " && document.getElementById('appGrid').getAttribute('aria-busy') === 'false'" +
                    " && document.getElementById('catalogBadge').textContent === 'Verified'"
            )
        }
    }

    @Test
    fun packagedCatalogSerializesToTheCanonicalBridgeResult() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val catalog = ArcaneAndroidApplicationCatalog(context).read()
        val request = AndroidBridgeProtocol.Request(
            id = "catalog-direct",
            method = GeneratedAndroidCapabilityRegistry.APPS_LIST_METHOD,
            externalUri = null
        )
        val response = JSONObject(AndroidBridgeProtocol.applicationCatalogResponse(request, catalog))
        assertTrue(response.getBoolean("ok"))
        val result = response.getJSONObject("result")
        assertTrue(result.getBoolean("verified"))
        assertEquals(17, result.getJSONArray("applications").length())
    }

    private fun waitForDocument(scenario: ActivityScenario<ArcaneLauncherActivity>) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            if (evaluate(
                    scenario,
                    "location.href === 'https://appassets.androidplatform.net/arcane/shell/index.html'" +
                        " && document.readyState === 'complete'"
                ) == "true") {
                return
            }
            Thread.sleep(100)
        }
        throw AssertionError("The packaged Arcane Shell did not finish loading.")
    }

    private fun waitForJavaScriptValue(
        scenario: ActivityScenario<ArcaneLauncherActivity>,
        expression: String
    ): String {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            val value = evaluate(scenario, expression)
            if (value != null) {
                return value
            }
            Thread.sleep(100)
        }
        throw AssertionError("The Arcane Android bridge did not return a result.")
    }

    private fun waitForJavaScriptTrue(
        scenario: ActivityScenario<ArcaneLauncherActivity>,
        expression: String
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            if (evaluate(scenario, expression) == "true") {
                return
            }
            Thread.sleep(100)
        }
        val state = evaluate(
            scenario,
            "JSON.stringify({" +
                "cards: document.querySelectorAll('.app-card').length," +
                "busy: document.getElementById('appGrid').getAttribute('aria-busy')," +
                "badge: document.getElementById('catalogBadge').textContent," +
                "status: document.getElementById('catalogState').textContent" +
                "})"
        )
        throw AssertionError("The Arcane Shell application catalog did not reach its ready state: $state")
    }

    private fun evaluate(
        scenario: ActivityScenario<ArcaneLauncherActivity>,
        script: String
    ): String? {
        val result = AtomicReference<String?>()
        val callback = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.hostedWebView?.evaluateJavascript(script) { encoded ->
                if (encoded != "null") {
                    result.set(JSONArray("[$encoded]").getString(0))
                }
                callback.countDown()
            } ?: callback.countDown()
        }
        assertTrue("JavaScript callback timed out.", callback.await(10, TimeUnit.SECONDS))
        return result.get()
    }
}
