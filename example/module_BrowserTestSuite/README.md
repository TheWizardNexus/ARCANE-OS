# BrowserTestSuite example

`BrowserTestSuite` runs a fixed parent-supplied inventory of trusted checks in
sequence. Each descriptor has `id`, `name`, `run`, and an optional shorter
`timeoutMs`. A callback receives `{signal, context, assert, skip}` and may be
synchronous or asynchronous. Results are normalized to `pass`, `fail`, or
`skip`, while an externally aborted run returns an `aborted` summary.

The suite emits `browser-test-suite-start`, `browser-test-start`,
`browser-test-result`, and `browser-test-suite-complete`. Event details and the
returned summary are frozen. Their detail shapes are `{tests, total}`,
`{index, test, total}`, `{index, result, total}`, and the final summary. The
module does not accept source strings, use
`eval`, persist results, or make visitor-authored code safe. Only checks bundled
or otherwise trusted by the parent application belong in the `tests` array.

Timeouts bound orchestration and abort the signal supplied to a callback. A
callback must cooperate with that signal to stop work it started after a
timeout. JavaScript running synchronously on the page cannot be preempted, so a
trusted check must also avoid long blocking work.
