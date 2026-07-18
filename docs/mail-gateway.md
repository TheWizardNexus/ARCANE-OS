# Arcane mail gateway

Arcane provides one reusable HTTP-to-SMTP gateway in `arcane/server/MailGateway.mjs`. PreCrisis and Warrior Spirit use the shared browser client in `arcane/modules/Mail.js`; application-specific report content, subjects, recipients, and crisis behavior stay in their applications.

This is a narrow web adapter, not a tunnel to Arcane Core or every native process. Each additional process exposed to hosted apps needs its own least-privilege contract, authentication/authorization policy, data review, limits, tests, and deployment route.

## Security boundary

The gateway is not a general public mail relay. It always binds to loopback. Production traffic must cross an authenticated TLS reverse proxy that:

1. authenticates the user before allowing the hosted application;
2. routes only the exact same-origin `POST /v1/mail` path to port 8025;
3. overwrites `X-Mail-App` and `X-Mail-Key` with server-owned values; and
4. leaves health and readiness endpoints private.

CORS, `Origin`, `Host`, and a key shipped to JavaScript do not authenticate a public user. They remain defense-in-depth: every mail request must include an exact configured `Origin`, in addition to proxy authentication and the server-owned app key. If the authenticated ingress is absent, hosted mail must remain unavailable. The static domain server remains a separate `GET`/`HEAD`-only process and does not gain a dynamic route.

The gateway accepts only a bounded JSON envelope with `type`, `subject`, `to`, and either `text` or `html`. It selects From addresses on the server, places recipients in BCC, disables Nodemailer file and URL access, and rejects attachments or caller-supplied SMTP fields. SMTP uses verified TLS 1.2 or newer, bounded stage timeouts, a 150-second absolute wall-clock deadline per fresh connection/attempt, and a small retry policy. The deadline owns and destroys its socket, so DNS, address fallback, TLS, or slow message streaming cannot continue after the HTTP timeout budget. Ambiguous provider disconnects and absolute-deadline outcomes are not retried because doing so can duplicate a message.

## Browser routing

`Mail.js` reads the app identity from `<meta name="arcane-app-id">` unless runtime configuration explicitly supplies one.

- From an HTTP loopback app, it sends to port 8025 on the page's exact loopback hostname (`localhost`, `127.0.0.1`, or `[::1]`) so Fetch Metadata remains same-site.
- From a hosted HTTPS app, it sends to same-origin `/v1/mail`.
- The browser does not contain a production application key.

The result contract distinguishes full acceptance from incomplete delivery:

| HTTP | `status` | Client result |
|---|---|---|
| 202 | `accepted` | `sent: true` |
| 207 | `partially_accepted` | `sent: false`, `partial: true` |
| 207 | `delivery_uncertain` | `sent: false`, `uncertain: true` |

PreCrisis closes its crisis-notification dialog only after `accepted`. Partial or uncertain delivery keeps an explicit fallback to direct contact and 988 visible.

## Local development

Set real SMTP values only in the terminal environment, then enable the narrowly constrained local mode:

```powershell
$env:MAIL_HOST='localhost'
$env:MAIL_PORT='8025'
$env:MAIL_LOCAL_DEVELOPMENT_ORIGIN_AUTH='true'
$env:MAIL_LOCAL_DEVELOPMENT_APPS='precrisis,warrior-spirit'
$env:MAIL_ALLOWED_ORIGINS='http://localhost:8000,http://127.0.0.1:8000'
$env:MAIL_SMTP_HOST='smtp.example.com'
$env:MAIL_SMTP_PORT='465'
$env:MAIL_SMTP_SECURE='true'
$env:MAIL_SMTP_USER='arcane-mail@example.com'
$env:MAIL_SMTP_PASS='<smtp app password>'
$env:MAIL_ERROR_RECIPIENTS='operations@example.com'
npm run mail:start
```

Serve the repository root on one of the exact allowed loopback origins and open PreCrisis normally. `MAIL_HOST` must match the hostname in that page URL; use `127.0.0.1` instead when the page also uses `127.0.0.1`. Local keyless mode fails configuration unless the gateway bind, allowed origins, remote peer, and app allowlist are all loopback-scoped.

## PreCrisis production deployment

The templates in `domains/precrisis.ai` implement the intended topology:

```text
browser --HTTPS + authentication--> Caddy
                                      |-- GET/HEAD --> 127.0.0.1:8080 static host
                                      `-- POST /v1/mail --> 127.0.0.1:8025 mail gateway --> SMTP TLS
```

1. Install dependencies from the committed lockfile and build/verify `dist/precrisis`.
2. Copy `mail-gateway.env.example` to `/etc/arcane/mail-gateway.env`, replace every placeholder, set ownership to root, and set mode 0600.
3. Create separate unprivileged `arcane-web` and `arcane-mail` service accounts, copy the two example units into `/etc/systemd/system/`, then enable both services. The static account must not receive or be able to inspect the mail environment.
4. With Caddy 2.8 or newer, copy `Caddyfile.example` into Caddy's configuration. In a separate Caddy-only environment, provide `ARCANE_WEB_USER`, a hash created by `caddy hash-password`, and the two per-app Caddy key variables. Each Caddy key must exactly match its corresponding value in `MAIL_APP_KEYS`; do not give Caddy the SMTP environment file.
5. Run `caddy validate --config /etc/caddy/Caddyfile`, reload Caddy, and verify the private readiness endpoint from the host before testing authenticated delivery.

The example protects the complete PreCrisis and Warrior Spirit hostnames with HTTP Basic authentication as a simple controlled-pilot gate. It is not per-user authorization, MFA, reliable logout, or an application audit system, and browser/service-worker data can outlive the network session. Use controlled devices and unique pilot credentials, or replace it with a reviewed per-user identity gateway before broader use. Any replacement must preserve the exact route, header overwrite, TLS, and fail-closed behavior. Do not combine the direct Node-on-443 static instructions with a claim that hosted mail works; mail requires this authenticated ingress topology.

## Operations and limits

- `GET /healthz` proves only that the process is alive. `GET /readyz` reflects the last SMTP verification state. Keep both loopback-only.
- Logs contain event names, request IDs, application IDs, counts, durations, and provider error codes, but not message bodies, recipients, SMTP credentials, or app keys.
- Idempotency records and rate limits are in memory. Run one gateway replica; restarts lose the replay cache. Add a reviewed shared store before horizontal scaling.
- The checked timeout chain is gateway drain at most 440 seconds, Caddy response headers at 450 seconds, and browser abort at 590 seconds. The default gateway drain budget is 425.5 seconds and is derived from queue wait, two absolute 150-second SMTP attempts, retry delay, and shutdown overhead. Startup fails if timeout overrides would cross the outer deadlines; keep the Caddy and systemd values aligned if this contract is deliberately revised in code.
- Sender and fixed error-recipient routing are process-wide. Apps sharing one process must intentionally share that routing policy; otherwise run separate loopback instances.
- Message bodies can contain sensitive profile, report, chat, or crisis information. The configured SMTP provider becomes a data processor with its own retention, region, access, deletion, and incident obligations.
- Rotate SMTP and application keys after suspected exposure. Never put them in HTML, JavaScript, a public package, a tracked environment file, or diagnostic output.

Run `npm run mail:test` for the focused server and browser transport contract. A real SMTP smoke test is deployment evidence and must use synthetic recipients and content; the automated suite never sends network mail.
