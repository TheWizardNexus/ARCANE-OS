# AsyncBoundary example

`runAsyncBoundary` gives one asynchronous operation a finite deadline and an
optional caller-controlled cancellation signal. A function operation receives
a child `AbortSignal`; a supplied promise is observed but cannot receive a new
signal after it has already started.

```js
import runAsyncBoundary from '../../arcane/modules/AsyncBoundary.js';

const requestController=new AbortController();
const value=await runAsyncBoundary(
    signal=>fetch('/synthetic.json',{signal}),
    {timeoutMs:3000,signal:requestController.signal}
);
```

The default timeout is 10 seconds. `timeoutMs` must be an integer from 1 through
300,000. Timeout rejects with `AsyncBoundaryTimeoutError` and code
`ASYNC_BOUNDARY_TIMEOUT`; external cancellation rejects with an `AbortError`
whose code is `ASYNC_BOUNDARY_ABORTED` and whose `cause` preserves the caller's
abort reason. Errors thrown or rejected by the operation are returned unchanged.
Invalid operations and options reject with `ASYNC_BOUNDARY_INVALID_OPERATION`
and `ASYNC_BOUNDARY_INVALID_OPTIONS`. The module also exports the two error
classes, the named `runAsyncBoundary` function, and frozen
`asyncBoundaryDefaults` metadata.

A signal that is already aborted prevents a function operation from starting.
Once a result, operation error, timeout, or external abort settles the boundary,
later outcomes are ignored and its timer and external abort listener are
removed.

The boundary limits asynchronous orchestration, not CPU execution. It cannot
preempt blocking synchronous JavaScript, and a task must listen to its supplied
signal to stop timers, requests, streams, or other work after cancellation. The
module does not persist data, make network requests, select providers, or retry.

The synthetic page loads `theme.css`, then `primitives.css`, and applies the
saved user appearance through `ThemeBootstrap.js`. Its controls remain native
keyboard-operable controls and task changes are announced through a polite
status region.
