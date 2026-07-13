# Arcane communications capability design record

## Reuse decision

**I need to make a capability that allows a user to connect communication services, see clearly identified conversations in one place, and reply through the originating service.**

This is useful to Mail, Messages, customer-support, case-work, and future notification applications. The shared record validation, provider registry, merged inbox, conversation renderer, composer, connection settings, and Arcane bridge client therefore live under `arcane/`.

The app-specific business logic is limited to product language and the providers/channels each app offers. `apps/mail/` selects email providers. `apps/messages/` selects Google Messages pairing, SMS, RCS, WhatsApp, and custom messaging bridges. Apps inject those descriptors into the shared components and hub.

## Public boundary

- `CommunicationMessage` and `CommunicationThread` normalize provider records and preserve provider/channel identity.
- `CommunicationProviderRegistry` validates provider adapters. Adapters expose `listThreads()`, `getMessages(threadId)`, and `send(input)`; `connect()` and `disconnect()` are optional.
- `ArcaneCommunicationBridge` implements the provider interface against a user-controlled bridge. The browser app stores only a bridge URL and non-secret account label. OAuth tokens and API secrets remain in the bridge or host credential service.
- `CommunicationHub` merges enabled providers, sorts threads, and routes replies to the provider that owns the thread.
- `unified-inbox.html`, `conversation-view.html`, and `integration-settings.html` accept parent configuration and emit neutral events. They do not persist, authenticate, or choose providers.

Google Messages is represented as a paired-web integration and an optional bridge source. Pairing can open the official web experience; unified reading and replying requires an adapter because Google does not document a public Messages inbox API.

## Security and privacy

- No password, OAuth token, API token, Twilio Auth Token, or WhatsApp system-user token is stored by these apps.
- Connection state is explicit: disconnected, action required, connecting, connected, or error.
- Provider and channel badges remain visible on every conversation.
- Message bodies are rendered as text. Provider HTML is never injected.
- Network operations are limited to the configured Arcane bridge contract and fail visibly.

