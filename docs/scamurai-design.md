# Scamurai capability decision

- **I need to make a:** protective capability that lets a person pause and evaluate a suspicious request, understand warning signs, preserve a minimal local incident history, and prepare a notice for a trusted contact.
- **Could other applications use it:** yes. Bounded, explainable signal matching is useful to safety, compliance, communications, and review applications.
- **App-specific business logic:** Scamurai branding, protective wording, trusted-contact workflow, result-only incident history, dashboard presentation, and fictional demonstration scenarios.
- **Reusable core:** `arcane/modules/RiskSignalAnalyzer.js` performs bounded explainable scoring; `arcane/modules/ScamRiskPolicy.js` supplies the cross-application scam-signal policy; `arcane/modules/InMemoryCommunicationProvider.js` supplies injected, network-free communication fixtures; and the communications controller/component accept provider factories and neutral advisories.
- **Extraction boundary:** configuration and injected providers. Scamurai maps the shared risk result to its dashboard. Arcane Messages maps the same result to a neutral message advisory for inbound SMS, MMS, and RCS from any configured provider.
- **Arcane theme base:** layout, theme, primitives, and `ThemeBootstrap.js` load before Scamurai styles.
- **CSS layer order:** Arcane layout -> Arcane theme -> Arcane primitives -> Scamurai CSS.
- **Shared files:** `arcane/modules/RiskSignalAnalyzer.js`, `arcane/modules/ScamRiskPolicy.js`, `arcane/modules/InMemoryCommunicationProvider.js`, `arcane/modules/CommunicationAppController.js`, and `arcane/components/conversation-view.html`.
- **App files:** `apps/scamurai/` and the thin integration policy in `apps/messages/modules/MessagesApp.js`.
- **Contract impact:** additive optional provider-factory, message-inspector, and advisory-action inputs. Existing communication consumers retain their prior behavior.
- **Current protection boundary:** explicit user-submitted text plus records delivered to Arcane Messages through an enabled communications provider. No DOM scraping, account-cookie access, passive reading of other applications, calls, or arbitrary browsing. No automatic email. A browser extension or native background monitor requires a separately reviewed, least-privilege capture/extension contract.

## Privacy and safety

Only check time, source label, score, level, and matched signal identifiers are retained with up to three trusted-contact addresses in app-scoped browser storage. SMS/message bodies are not retained by Scamurai history or included in prepared contact reports. The user must review and send mail in their mail client. Scamurai is a decision aid and does not claim to guarantee that content is safe or fraudulent.

## Google Messages boundary

Google Messages for web remains the official paired web client. Scamurai opens it as a separate user-controlled page for manual copy/check. Arcane does not scrape its DOM, reuse its cookies, or claim a private consumer API. Automatic checks occur only when an authorized local/Android communications adapter supplies Google Messages records through Arcane's existing provider-neutral bridge contract. The built-in `scamurai-demo` provider uses fixed fictional SMS records so the complete advisory flow can be demonstrated without a Google account, phone, network, or real message data.

## Accessibility target

The first version uses native headings, form controls, lists, status text, visible focus, a live result region, text equivalents for status, responsive reflow, forced-color handling, and 44-pixel minimum primary actions. Native-host keyboard, NVDA/Narrator, zoom, custom-theme, and representative-user verification remain required before a release claim.
