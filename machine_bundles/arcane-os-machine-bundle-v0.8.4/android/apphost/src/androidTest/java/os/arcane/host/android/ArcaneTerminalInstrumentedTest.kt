package os.arcane.host.android

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ArcaneTerminalInstrumentedTest {
    @Test
    fun terminalRunsACommandThroughTheAndroidApplicationSandbox() {
        assumeTrue(BuildConfig.ARCANE_APP_ID == "terminal")
        ActivityScenario.launch(ArcanePackagedApplicationActivity::class.java).use { scenario ->
            waitForTrue(
                scenario,
                "document.querySelector('#terminalWorkspace')?.shadowRoot" +
                    "?.querySelector('#connection')?.dataset?.state === 'running'"
            )
            evaluate(
                scenario,
                """
                    (() => {
                        const workspace = document.querySelector('#terminalWorkspace');
                        const input = workspace?.shadowRoot?.querySelector('#input');
                        if (!input) return false;
                        input.value = 'echo ARCANE_ANDROID_TERMINAL_OK';
                        input.dispatchEvent(new KeyboardEvent('keydown', {
                            key: 'Enter',
                            bubbles: true,
                            cancelable: true
                        }));
                        return true;
                    })()
                """.trimIndent()
            ).also { assertEquals("true", it) }
            waitForTrue(
                scenario,
                "document.querySelector('#terminalWorkspace')?.shadowRoot" +
                    "?.querySelector('#output')?.textContent" +
                    "?.includes('ARCANE_ANDROID_TERMINAL_OK') === true"
            )
        }
    }

    private fun waitForTrue(
        scenario: ActivityScenario<ArcanePackagedApplicationActivity>,
        expression: String
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            if (evaluate(scenario, expression) == "true") return
            Thread.sleep(100)
        }
        val diagnostics = evaluate(
            scenario,
            """
                JSON.stringify((() => {
                    const workspace = document.querySelector('#terminalWorkspace');
                    return {
                        href: location.href,
                        readyState: document.readyState,
                        title: document.title,
                        body: document.body?.innerText?.slice(0, 1000) ?? null,
                        workspaceReady: workspace?.ready ?? null,
                        preferencesReady: document.querySelector('#preferencesForm')?.ready ?? null,
                        arcaneType: typeof globalThis.Arcane,
                        terminalStartType: typeof globalThis.Arcane?.terminal?.start,
                        connection: workspace?.shadowRoot?.querySelector('#connection')?.dataset?.state ?? null,
                        output: workspace?.shadowRoot?.querySelector('#output')?.textContent?.slice(0, 1000) ?? null,
                        resources: performance.getEntriesByType('resource')
                            .map(entry => entry.name)
                            .filter(name => name.includes('Terminal') || name.includes('Preference'))
                    };
                })())
            """.trimIndent()
        )
        throw AssertionError("Timed out waiting for Android Terminal state: $expression; state=$diagnostics")
    }

    private fun evaluate(
        scenario: ActivityScenario<ArcanePackagedApplicationActivity>,
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
