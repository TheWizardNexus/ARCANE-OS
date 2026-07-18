# precrisis.ai domain host

This folder is the deployment adapter for the public PreCrisis AI domain. It keeps domain-specific copy, hostnames, certificates, app selections, and process-manager/proxy templates separate from the reusable static and mail servers under `arcane/server/`.

## Routes

- `precrisis.ai` serves the allowlisted marketing-site release in `public/`.
- `www.precrisis.ai` redirects to the apex site.
- `app.precrisis.ai` serves the verified `dist/precrisis` package.
- The hosted PreCrisis client sends mail to same-origin `POST /v1/mail`. That route exists only at the authenticated reverse proxy and forwards to the loopback Arcane mail gateway; the static server continues to reject it.
- The other names in `domain.config.json` serve only their explicitly selected, verified `dist/<id>` release.
- Public network/frame/media origins are an explicit HTTPS-only subset under `publicAppSecurity`; native loopback services are not reachable through an inherited app CSP.
- Unknown hosts, unlisted release files, traversal attempts, request bodies, and methods other than `GET`/`HEAD` fail closed.
- `/.well-known/acme-challenge/<token>` is the only mutable webroot path and is available on every configured hostname for Certbot HTTP-01 validation.

Do not point the host at the repository root or directly at `apps/`. A public app URL must use the complete verified `dist/<id>` package so its `apps/`, `arcane/`, and allowlisted dependency paths remain intact.

## Local run

From the repository root:

```powershell
node domains/precrisis.ai/scripts/build-site-release.mjs
node domains/precrisis.ai/server.mjs
```

Then open `http://127.0.0.1:8080/`. The loopback hostname is accepted only for local development. Subdomain routing can be checked without changing DNS:

```powershell
curl.exe -I -H "Host: app.precrisis.ai" http://127.0.0.1:8080/
curl.exe -I -H "Host: weather.precrisis.ai" http://127.0.0.1:8080/
```

To exercise mail locally, configure real SMTP values only in the terminal environment and start `npm run mail:start` in a second terminal. The exact loopback-only development variables are documented in [`docs/mail-gateway.md`](../../docs/mail-gateway.md). PreCrisis automatically selects port 8025 on the page's exact loopback hostname.

## Production listener (static-only)

The server defaults to loopback and port 8080. A Linux service manager can supply the production binding and require TLS:

```bash
ARCANE_WEB_HOST=0.0.0.0 \
ARCANE_HTTP_PORT=80 \
ARCANE_HTTPS_PORT=443 \
ARCANE_REQUIRE_TLS=1 \
node domains/precrisis.ai/server.mjs
```

The default certificate paths are `/etc/letsencrypt/live/precrisis.ai/fullchain.pem` and `/etc/letsencrypt/live/precrisis.ai/privkey.pem`. Override them with `ARCANE_TLS_CERT_PATH` and `ARCANE_TLS_KEY_PATH`. Send `SIGHUP` after renewal to reload certificate bytes without replacing the process.

Run this as a dedicated unprivileged service identity. Certbot creates private keys as mode `0600`, and its `live` and `archive` directories may be mode `0700`. For direct Node TLS, follow Certbot's dedicated-group pattern: make only the required certificate directories traversable, assign `privkey.pem` to the service's narrow group, and set it to `0640`. Certbot preserves an adjusted group and group mode across renewals. Never make the private key world-readable.

If Node binds ports 80/443 directly, grant only the operating-system capability needed for low ports; do not run the application as a general-purpose administrator. This direct Node-on-443 topology serves static content only and must not be described as hosted-mail capable. If a trusted reverse proxy terminates TLS, bind Node to loopback and make the edge own HTTP-to-HTTPS redirection, `www` canonicalization, HSTS, request/connection limiting, exact Host forwarding, and certificate reload; the HTTP backend does not trust forwarded-protocol headers.

## Production listener with Arcane mail

Hosted mail requires the concrete three-process topology supplied here:

- `arcane-web.service.example` runs the exact-host static server as `arcane-web` on `127.0.0.1:8080`;
- `arcane-mail.service.example` runs `arcane/server/MailGateway.mjs` as a separate `arcane-mail` identity on `127.0.0.1:8025`; and
- `Caddyfile.example` terminates public TLS, authenticates the complete PreCrisis/Warrior Spirit host, serves static requests through port 8080, and routes only `POST /v1/mail` through port 8025 with server-owned app credentials.

Copy `mail-gateway.env.example` to a root-owned mode-0600 secret file and replace every placeholder. The browser must never receive the SMTP password or gateway application keys. CORS and Origin checking are supplemental browser controls, not user authentication. Full setup, response semantics, rotation, health/readiness, and single-replica constraints are in [`docs/mail-gateway.md`](../../docs/mail-gateway.md).

## DNS and Certbot

Create `A`/`AAAA` records for every name printed by:

```bash
node domains/precrisis.ai/server.mjs --list-hostnames
```

With the HTTP listener reachable on port 80, issue the enumerated SAN certificate:

```bash
CERTBOT_EMAIL=admin@example.com \
CERTBOT_STAGING=1 \
./domains/precrisis.ai/certbot.sh issue
```

For first issuance there is no certificate to satisfy `ARCANE_REQUIRE_TLS=1`. Start the HTTP listener on public port 80 with TLS not required, confirm the challenge path is reachable for every DNS name, then run the command above. `CERTBOT_STAGING=1` uses Certbot's dry-run mode and saves no staging certificate. After it succeeds, omit `CERTBOT_STAGING` for production issuance, grant the dedicated service group read access as described above, and restart with TLS required.

Test renewal with `./domains/precrisis.ai/certbot.sh dry-run`; renew with `./domains/precrisis.ai/certbot.sh renew`. A service manager can be connected through `CERTBOT_DEPLOY_HOOK`, using an absolute, narrowly scoped executable that sends `SIGHUP` only to this process. The dry-run action uses `--run-deploy-hooks` when that variable is present, so the reload path is tested against the current active certificate.

This script uses HTTP-01 and therefore enumerates every hostname. A wildcard certificate requires DNS-01 and provider-specific credentials; no DNS provider was assumed or embedded here. When the Caddy deployment is selected for hosted mail, use Caddy's managed TLS instead of running a second certificate terminator on the same public ports.

## Updating a site or subdomain

1. Change only files under `public/`, then run `node domains/precrisis.ai/scripts/build-site-release.mjs` and commit the updated `site-release.json`.
2. For an app, package and verify it with `node tools/package-app.mjs package <id>` followed by `node tools/package-app.mjs check <id>`.
3. Add the app to `distApps` only after it is declared in the Arcane application registry and has a verified release marker.
4. Complete a public-rights, sensitive-data, browser-capability, security, and privacy review of the package contents.
5. Add DNS for the resulting hostname, rerun Certbot issuance with the complete name set to update the certificate, then reload the service.

Browser hosting does not grant native `window.Arcane` capabilities. Apps that require the native host must fail safely or present a clear unavailable state. Test provider CORS, mixed-content, microphone, OPFS, service-worker, and failure paths on the real HTTPS origin before describing an app as fully supported on the web.

Package integrity is not publication authorization. `boss.precrisis.ai` is intentionally absent because the current BOSS package contains a large originals/document corpus that has not completed a public-rights and sensitive-data review. Create a separate browser-safe release profile before adding that hostname.

## `node-http-server` compatibility decision

The current public `node-http-server` package was not made the production request handler because its static path construction does not establish the containment and positive-inventory guarantees required here. The domain adapter uses dependency-free `node:http` and `node:https` now. A later package release can replace the transport only after equivalent tests prove exact Host handling, decoded-path containment, bounded requests, security headers, release-manifest enforcement, and graceful TLS reload.
