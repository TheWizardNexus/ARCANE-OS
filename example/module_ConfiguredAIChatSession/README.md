# Configured AI chat session example

`ConfiguredAIChatSession` maintains a bounded, in-memory system/user/assistant history and sends it through an injected `chat(request)` function. When no function is injected, it resolves `globalThis.Arcane.ai.chat` at send time so Arcane Core can apply the signed-in user's configured provider.

The reusable module owns only conversation mechanics:

- `new ConfiguredAIChatSession(options)` accepts a static `systemPrompt`, an optional async `contextBuilder({input, history})`, optional provider `request` defaults, and bounded history limits.
- `send(text)` validates the user text, calls the provider once, commits a complete user/assistant turn only after a valid response, and returns normalized `provider`, `model`, `message`, completion, and token-count fields.
- `history()` returns a frozen snapshot. `clear()` removes conversation turns and restores the static system prompt.
- Concurrent sends, malformed messages, invalid provider responses, and exceeded limits fail with observable errors. Failed requests do not partially change history.

The module does not persist conversations, choose a provider, render content, stream output, or execute tools. The parent application owns system wording, context selection, display, authorization, and persistence. Context supplied by the parent is sent to the configured provider, so the parent must exclude secrets and private material that the provider should not receive.

The synthetic page injects a deterministic local function; it does not call a network service or require credentials.
