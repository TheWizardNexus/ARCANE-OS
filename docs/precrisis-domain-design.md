# PreCrisis public-domain host design

Date: 2026-07-18

## Capability decision

1. **What capability is being added?** An operator can publish a small allowlisted PreCrisis marketing site and explicitly selected packaged Arcane applications at exact HTTPS subdomains. An authenticated hosted PreCrisis or Warrior Spirit session can also submit a bounded same-origin notification to a loopback Arcane gateway that delivers it through operator-configured SMTP.
2. **Could other apps or domains use the capability?** Yes. Exact-host static serving and the bounded HTTP-to-SMTP mechanism are both domain-independent. Each additional hosted mail app still requires an explicit authenticated ingress policy, app identity/key, Origin allowlist, sender policy, and data review.
3. **What remains PreCrisis-specific?** Marketing copy and imagery, `precrisis.ai` hostnames and app maps, report/crisis subjects and payload selection, user-selected support recipients, urgent-support recovery language, proxy routing identities, and deployment sender/error-recipient policy.
4. **Where is the reusable capability?** [`arcane/server/StaticDomainServer.mjs`](../arcane/server/StaticDomainServer.mjs) owns verified static publication; [`arcane/server/MailGateway.mjs`](../arcane/server/MailGateway.mjs), [`arcane/modules/Mail.js`](../arcane/modules/Mail.js), and [`arcane/modules/MailTransport.mjs`](../arcane/modules/MailTransport.mjs) own the reusable mail mechanism and browser contract. [`domains/precrisis.ai`](../domains/precrisis.ai) remains the thin domain and deployment adapter.

That boundary prevents either a domain-local static-server fork or a PreCrisis-local SMTP relay. The static server remains `GET`/`HEAD` only. Mail is a separate loopback process behind an authenticated reverse proxy; uploads and other dynamic business endpoints remain outside both shared contracts.

## Publication topology

- `precrisis.ai` serves only files named by `domains/precrisis.ai/site-release.json`.
- `www.precrisis.ai` redirects to the apex hostname.
- `app.precrisis.ai` serves the verified `dist/precrisis` release; other subdomains are explicit mappings to registered, verified `dist/<id>` releases. BOSS is excluded because its current release includes a document/source corpus that has not been authorized for public publication.
- Site theme and brand aliases are selected files from the verified PreCrisis app release. The repository root and unpackaged source trees are never publication roots.
- Unknown hosts, unknown files, directory paths, malformed targets, bodies, and non-`GET`/`HEAD` methods fail closed.
- In the mail-capable topology, Caddy authenticates the complete `app.precrisis.ai` and `warrior-spirit.precrisis.ai` hosts. It sends static requests to loopback port 8080 and routes only exact `POST /v1/mail` to loopback port 8025 after overwriting caller mail identity headers with server-owned values.
- Public CSP network, frame, and media origins are explicit per-app HTTPS allowlists that can only narrow the native registry. Loopback services are never inherited into a public origin.
- `/.well-known/acme-challenge/<token>` is the one mutable webroot route and accepts only a single safe token filename.

Browser hosting is intentionally narrower than the native Arcane host. It does not grant native capabilities; an individual app may still require provider CORS, microphone permission, OPFS, service-worker, mixed-content, and recovery testing on its real HTTPS origin.

The current packaged PreCrisis first-run terms overstate on-device exclusivity relative to its optional network-model paths. The public site therefore labels the app a non-sensitive preview and links an accurate boundary notice. Correcting and repackaging the app is a launch gate, not a domain-server responsibility.

## Theme and interface compliance

The apex page loads `/arcane/css/theme.css` first, initializes `/arcane/modules/ThemeBootstrap.js` before paint, then loads `/arcane/css/primitives.css` and `site.css`. New color literals use `rgb(...)` or `rgba(...)`, with system color names limited to the forced-colors media query. Layout, visible focus, reduced motion, forced colors, reflow, semantic landmarks, skip navigation, link purpose, and emergency-resource language are covered by the page implementation and focused assertions; actual browser and assistive-technology evidence is tracked separately.

## Packaging and contract impact

The static server remains dependency-free and uses built-in Node HTTP, HTTPS, filesystem, URL, and cryptographic APIs. The separate gateway adds the pinned public `nodemailer` package for SMTP. Both npm and pnpm locks record the dependency. A static-site manifest generator records exact relative names, byte sizes, and SHA-256 digests. Dist apps remain governed by the existing application registry and `ARCANE_APP_RELEASE.json`; the domain configuration cannot publish an unregistered app or a file absent from its verified release.

The browser contract automatically selects loopback port 8025 from an HTTP development origin and same-origin `/v1/mail` from HTTPS. The native PreCrisis and Warrior Spirit package policies allow the loopback gateway explicitly. No SMTP or production app credential enters an app package. Delivery results distinguish accepted, partial, and uncertain outcomes so crisis recovery does not claim more than the provider confirmed.

The public `node-http-server` package is not the initial production handler because its current path construction does not establish the containment and positive-inventory contract required here. It can be reconsidered only if a tested version preserves every host, path, request, header, integrity, ACME, and TLS guarantee in this design.

## Verification boundary

Static-focused tests cover configuration validation, exact host routing, redirects, app and shared-asset serving, `HEAD`, ACME tokens, unknown hosts, unsupported methods, body rejection, traversal, malformed encoding, release tampering, theme order, CTA, and page structure. Local browser/reflow evidence and its explicit gaps are recorded in [`precrisis-domain-accessibility.md`](precrisis-domain-accessibility.md). Mail-focused tests cover production and local authorization, CORS, bounded payloads, routing, BCC-only SMTP messages, transient/ambiguous failure handling, partial acceptance, idempotency, queues, rate limits, health/readiness, graceful drain, and browser response semantics.

Production DNS, Caddy validation on the target host, real authentication, real SMTP/TLS verification and synthetic delivery, service-account permissions, public HTTPS behavior, provider retention/region review, native-capability substitutions, keyboard/screen-reader recovery journeys, and release-candidate acceptance remain deployment evidence and are not claimed by this implementation.
