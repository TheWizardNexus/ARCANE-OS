package os.arcane.host.android

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ArcaneBrowserInstrumentedTest {
    @Test
    fun browserConfiguresItsPackagedNavigatorAndLoadsTheRegisteredHomeUrl() {
        assumeTrue(BuildConfig.ARCANE_APP_ID == "browser")
        ActivityScenario.launch(ArcanePackagedApplicationActivity::class.java).use { scenario ->
            waitForTrue(
                scenario,
                """
                    (() => {
                        const navigator = document.querySelector('#navigator');
                        const frame = navigator?.shadowRoot?.querySelector('#frame');
                        const status = navigator?.shadowRoot?.querySelector('#status');
                        return location.href === 'https://browser.arcane.invalid/browser/index.html'
                            && document.readyState === 'complete'
                            && navigator?.ready === true
                            && typeof navigator.configure === 'function'
                            && navigator.currentUrl() === 'https://example.com/'
                            && frame?.src === 'https://example.com/'
                            && status?.textContent?.startsWith('Loaded.') === true;
                    })()
                """.trimIndent()
            )
        }
    }

    private fun waitForTrue(
        scenario: ActivityScenario<ArcanePackagedApplicationActivity>,
        expression: String
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            if (evaluate(scenario, expression) == "true") return
            Thread.sleep(100)
        }
        val state = evaluate(
            scenario,
            """
                JSON.stringify((() => {
                    const navigator = document.querySelector('#navigator');
                    return {
                        href: location.href,
                        readyState: document.readyState,
                        navigatorReady: navigator?.ready ?? null,
                        configureType: typeof navigator?.configure,
                        currentUrl: navigator?.currentUrl?.() ?? null,
                        frameUrl: navigator?.shadowRoot?.querySelector('#frame')?.src ?? null,
                        status: navigator?.shadowRoot?.querySelector('#status')?.textContent ?? null
                    };
                })())
            """.trimIndent()
        )
        throw AssertionError("The packaged Android Browser did not reach its loaded state: $state")
    }

    private fun evaluate(
        scenario: ActivityScenario<ArcanePackagedApplicationActivity>,
        script: String
    ): String? {
        val result = AtomicReference<String?>()
        val callback = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.hostedWebView?.evaluateJavascript(script) { encoded ->
                if (encoded != "null") result.set(JSONArray("[$encoded]").getString(0))
                callback.countDown()
            } ?: callback.countDown()
        }
        assertTrue("JavaScript callback timed out.", callback.await(10, TimeUnit.SECONDS))
        return result.get()
    }
}
