# PreCrisis public-domain security and privacy review

Date: 2026-07-18
Scope: shared static-domain server, shared mail gateway/client, and the `precrisis.ai` deployment adapter
Authority: automated implementation review only; no human risk acceptance or release-candidate approval

## Assets, actors, data, and boundaries

Protected assets are the public release bytes and their provenance, hostname/DNS authority, TLS private key material, certificate continuity, service availability, SMTP and per-app proxy credentials, recipient addresses, notification bodies, stored reports, and any personal or provider data a browser-hosted Arcane app stores or sends. Actors include an anonymous visitor, an authenticated app user, an operator, Caddy or a replacement identity proxy, an SMTP provider, an ACME validation service, a network attacker, a malicious request sender, and a compromised or mistakenly packaged release.

The principal static boundaries are Internet to TLS ingress, Host authority to an exact route, URL path to a positive release inventory, ACME token files to the challenge response, TLS key files to the HTTPS context, and a browser origin to an app's storage/providers. Mail adds authenticated ingress to Caddy, exact `/v1/mail` dispatch, overwritten server-owned app identity headers, a loopback HTTP gateway, SMTP over verified TLS, and external provider handling. The marketing site itself accepts no accounts, form submissions, uploads, or personal-health input.

## Implemented controls

- Exact canonical, redirect, and app hosts are loaded from configuration; unknown or ambiguous Host headers fail closed.
- Only `GET` and `HEAD` are accepted. Bodies are rejected, header counts/sizes and timeouts are bounded, directory listings are absent, and generic errors avoid internal paths.
- Request paths are decoded once, reject malformed escapes, backslashes, NULs, dot segments, and hidden/special paths, then are checked by lexical and real-path containment.
- The apex site and every app are positive inventories with size and SHA-256 binding. A changed byte is refused rather than served.
- App publication requires both an Arcane registry entry and a verified `ARCANE_APP_RELEASE.json` package. The repository and unpackaged app source are not roots.
- Package integrity is not treated as publication authorization: the BOSS release is excluded because its bundled source/document corpus has not completed a public-rights and sensitive-data review.
- CSP, Permissions Policy, same-origin resource/opener policy, no-sniffing, frame denial, referrer policy, per-host cache behavior, and HTTPS HSTS constrain the browser surface. App inline scripts are admitted by generated hashes, not `unsafe-inline` script execution.
- Public app network, frame, and media origins are HTTPS-only deployment allowlists that must be subsets of the native registry. Native loopback Arcane, Ollama, mail, and message services are therefore absent from public CSP.
- HTTP-01 exposes only an exact safe token file under the configured challenge root. Certificate and key bytes are read outside the webroot and may be reloaded on `SIGHUP`.
- Static Node serving remains `GET`/`HEAD` only and dependency-free. The mail gateway is a separate loopback-only process; its one pinned runtime package is Nodemailer.
- Production mail configuration fails closed without SMTP credentials, fixed error routing, and a 32-character-or-longer server-side app key. Keyless mode requires an explicit loopback bind, loopback peer, loopback Origin allowlist, and app allowlist.
- The Caddy template authenticates the complete PreCrisis/Warrior Spirit host, routes only exact `/v1/mail`, and overwrites untrusted `X-Mail-App` and `X-Mail-Key` values before forwarding. Health and readiness are not routed publicly.
- The gateway allowlists JSON fields and mail types; bounds headers, bodies, recipients, message bytes, timeouts, concurrency, queues, retries, rate state, and idempotency state; selects senders on the server; uses BCC; and disables file/URL access.
- SMTP configuration requires implicit TLS or STARTTLS with TLS 1.2+, certificate validation, readiness verification, bounded stage timeouts, and an absolute per-attempt deadline that destroys its owned socket. Ambiguous or deadline-expired results are not retried, and clients do not report partial or uncertain acceptance as `sent`.
- Report formatting is deterministic in the browser. Crisis, chat, profile, or report content is not sent to an AI provider for email composition, and affected debug logging no longer prints crisis values or recipient lists.
- Structured gateway logs omit recipients, message content, SMTP credentials, and app keys.

## Findings and disposition

No Critical or High implementation finding is accepted or waived here. Focused hostile-input tests pass. The following deployment findings remain open:

| Severity | Finding | Required disposition |
|---|---|---|
| Medium | A browser origin cannot supply native `window.Arcane` capabilities. Individual apps may fail, degrade unclearly, or expose provider/network behavior that differs from the native host. | Validate each published app on its real HTTPS subdomain, document browser support, and remove any app that does not fail safely. |
| Medium | This change does not provision DNS, obtain a production certificate, harden a Linux service account, configure firewall/rate limiting, or prove renewal/reload. Certbot's key and directory defaults also need a narrow service-group read grant for direct Node TLS. | Complete issuance dry-run, production issuance, renewal/deploy-hook dry-run, least-privilege certificate access and service setup, public-header checks, monitoring, and recovery evidence before launch. If an edge terminates TLS, it must own redirects, canonicalization, HSTS, limiting, and exact Host forwarding. |
| Medium | The authenticated Caddy topology is a deployment template, not verified identity infrastructure. Without a real deployed authentication layer, `/v1/mail` would become an arbitrary-recipient relay if exposed. | Keep both Node ports loopback-only; validate Caddy on the target host; require authentication on the complete app host; prove caller headers are overwritten; and fail closed if authentication is unavailable. |
| Medium | The example's shared HTTP Basic credential is suitable only as a simple controlled-pilot gate. It does not provide per-user roles, MFA, reliable browser logout, recipient authorization, or application audit, and previously cached app content can remain on the device. | Use unique pilot credentials with device/browser controls and tested cache/data cleanup, or replace Basic auth with a reviewed per-user identity/session gateway before broader use. Keep recipient selection and mail activity within the approved user/role policy. |
| Medium | Crisis, chat, profile, and report content can cross to the configured SMTP provider and recipients. Provider retention, region, access, incident response, and deletion behavior are external. | Approve a provider and data-processing policy for the intended data classes, minimize recipients/content, use synthetic deployment tests, document user disclosure, and establish retention/deletion/incident procedures before real use. |
| Medium | The current packaged PreCrisis first-run terms say information remains exclusively on-device, while the package can send prompts, conversation content, or audio to a selected network provider. | The marketing site labels the app a non-sensitive preview and adds an accurate boundary notice. Correct the app source, rebuild and verify the package, then remove the preview warning only after review. |
| Medium | Apps share the same registrable domain. Browser mechanisms such as cookies with a broad Domain attribute could cross subdomains even though storage origins differ. | Keep cookies host-only, do not treat sibling subdomains as mutually trusted, and test cross-origin/provider policies for each app. |
| Low | Release hashes are checked lazily and cached by file size and modification time. A same-size malicious replacement that can also restore the timestamp after the first verified read could evade the cache. | Protect published files from the service identity and untrusted writers. For a stronger immutable deployment, publish read-only versioned directories and restart on atomic release switch. |
| Low | Static hosting has no application-layer per-client rate limiter. Header and socket limits reduce simple exhaustion but do not replace an edge or host firewall. | Add narrowly configured edge/OS connection controls and monitor resource saturation for the public deployment. |
| Low | Mail idempotency and rate state are in memory and lost on restart; multiple replicas do not share it. An uncertain provider outcome can still mean a message was delivered even when the UI cannot confirm it. | Run one gateway replica, preserve explicit partial/uncertain UI, and design a reviewed durable shared store before horizontal scale or stronger restart guarantees. |
| Low | Sender and fixed error-recipient routing are process-wide for all configured app keys. | Share one process only where apps intentionally share routing policy; otherwise use separate loopback gateway instances and credentials. |

## Privacy assessment

The apex page deliberately avoids collection and avoids claims that the product is an emergency, diagnostic, or sole decision service. It links to the official 988 resource and states that imminent danger or medical emergencies require 911. Browser-hosted applications may handle journal, assessment, audio, local storage, model-provider, exported, or mailed data; those flows retain their own capability and privacy obligations and must be reviewed on the deployed origin. Publishing an app is not consent to move user data to an AI or SMTP provider. Mail recipients and the SMTP provider become explicit additional consumers, and the locally saved report remains subject to browser/profile retention and deletion behavior.

## Required launch evidence

Before public launch: verify exact DNS records; validate and stage Caddy; issue the certificate; prove HTTP-to-HTTPS redirect, HSTS, and full-host authentication; prove direct access to ports 8080/8025 is blocked; demonstrate that browser-supplied mail headers are overwritten; inspect every hostname; run host/path/body/auth/rate abuse tests through the public edge; verify the static identity cannot read mail secrets and neither Node identity can write releases; verify SMTP TLS/readiness with synthetic data; exercise accepted, partial, uncertain, unavailable, restart, certificate renewal, credential rotation, rollback, and accessible recovery paths; review logs for data minimization; and approve provider/recipient retention and incident handling. An accountable human reviewer must disposition residual risks.
