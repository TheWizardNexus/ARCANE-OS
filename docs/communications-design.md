# Arcane communications capability design record

## Reuse decision

**I need to make a capability that allows a user to connect communication services, see clearly identified conversations in one place, and reply through the originating service.**

This is useful to Mail, Messages, customer-support, case-work, and future notification applications. The shared record validation, provider registry, merged inbox, conversation renderer, composer, connection settings, and Arcane bridge client therefore live under `arcane/`.

The app-specific business logic is limited to product language and the providers/channels each app offers. `apps/mail/` selects email providers. `apps/messages/` selects Google Messages pairing, SMS, RCS, WhatsApp, and custom messaging bridges. Apps inject those descriptors into the shared components and hub.

## Public boundary

- `CommunicationMessage` and `CommunicationThread` normalize provider records and preserve provider/channel identity.
- `CommunicationProviderRegistry` validates provider adapters. Adapters expose `listThreads()`, `getMessages(threadId)`, and `send(input)`; `connect()` and `disconnect()` are optional.
- `InMemoryCommunicationProvider` supplies fixed, network-free records for examples and clearly labeled demonstrations. Its sends mutate only its in-memory fixture.
- `ArcaneCommunicationBridge` implements the provider interface against a user-controlled bridge. The browser app stores only a bridge URL and non-secret account label. OAuth tokens and API secrets remain in the bridge or host credential service.
- `CommunicationHub` merges enabled providers, sorts threads, and routes replies to the provider that owns the thread.
- `CommunicationAppController` accepts optional `providerFactory`, `inspectMessage`, and `onAdvisoryAction` injections. Inspection output is normalized and bounded through `MessageAdvisory`; failures produce an explicit unavailable advisory, object-keyed maps prevent hostile or duplicate message IDs from aliasing warnings, and stale selections cannot replace a newer thread.
- `unified-inbox.html`, `conversation-view.html`, and `integration-settings.html` accept parent configuration and emit neutral events. The conversation view renders advisory text and relies on the controller's live status summary for a concise screen-reader announcement. They do not persist, authenticate, inspect content, or choose providers.

Google Messages is represented as a paired-web integration and an optional bridge source. The official page may be opened in a normal supported browser, but Arcane does not scrape, embed, or reuse its account session. Unified reading, Scamurai inspection, and replying require an independently authorized local/Android adapter because Google does not document a public consumer Messages inbox API. The packaged demo is fixed fictional data, not Google Messages capture.

## Security and privacy

- No password, OAuth token, API token, Twilio Auth Token, or WhatsApp system-user token is stored by these apps.
- Connection state is explicit: disconnected, action required, connecting, connected, or error.
- Provider and channel badges remain visible on every conversation.
- Message bodies are rendered as text. Provider HTML is never injected.
- Content inspection is local and provider-neutral. Advisory fields and counts are bounded; an inspector error never becomes a silent no-warning result.
- Network operations are limited to the configured Arcane bridge contract and fail visibly.

