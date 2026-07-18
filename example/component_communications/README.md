# Communications components

This example demonstrates the shared unified inbox and conversation view with two synthetic providers. Parent applications select providers, persist connection settings, inject optional content inspection, and route authentication. Shared components render normalized records and emit `thread-select`, `inbox-refresh`, `communication-send`, and optional advisory-action events.

Production adapters implement `listThreads()`, `getMessages(threadId)`, and `send(input)`. `CommunicationAppController` can receive a `providerFactory` for local/demo providers and an `inspectMessage` callback. Advisory results use `{level,title,summary,signals,actionLabel}`; they are bounded before rendering, message-object keyed, and inspector failures become an explicit unavailable result.

Serve the repository root and open `/example/component_communications/index.html`.
