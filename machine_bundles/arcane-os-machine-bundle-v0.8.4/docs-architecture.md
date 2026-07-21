# Arcane Native Bridge Architecture

## Arcane RPC envelope

Request:

```json
{
  "protocol": "arcane/1",
  "type": "request",
  "id": "uuid",
  "method": "users.add",
  "parameters": { "usernames": ["arcane1"] }
}
```

Response:

```json
{
  "protocol": "arcane/1",
  "type": "response",
  "id": "uuid",
  "ok": true,
  "result": {}
}
```

Event:

```json
{
  "protocol": "arcane/1",
  "type": "event",
  "event": "operation.progress",
  "data": {
    "operationId": "uuid",
    "progress": 50,
    "message": "Verifying Arcane installation..."
  }
}
```

Frames between the native host and Node use:

```text
Content-Length: <UTF-8 byte count>\r\n
\r\n
<JSON bytes>
```

Stdout is protocol-only. Logs use stderr.

## Application identity and authorization

Every Core process starts with one application id. `arcane-bundle.json` describes the built-in `provisioner` and `shell`; a targeted package contains only its selected generic app descriptor. The descriptor includes an application type, entry point, and capability grants.

`src/api/method-policies.json` is the canonical RPC authority registry. Its validated records own method-to-capability, application-id/type, privilege, exclusive-mutation, and host-availability metadata. Generation freezes the Core registry, every policy record, and its application constraint arrays; target-app Cores consume the same data. Android host admission and method-to-capability lookup are generated separately: capability-free `system.ping`, `version.current`, and `app.current` remain bound-session bootstrap methods, while `platform.status`/`system.read`, `network.status`/`network.status.read`, and `external.open` retain explicit capabilities. Supported-without-capability is not conflated with unsupported. Verification fails on unknown fields, duplicate or noncanonical serialization, invalid principals, unsupported host declarations, unknown manifest grants/applications, or drift among the canonical registry, generated Core, dispatch, frontend wrappers, and Android constants.

`src/api/method-contracts.json` is a separate canonical semantic registry. Its current vertical slice versions fifteen Core/Android methods: bootstrap, identity, platform, network, external-open, application catalog/launch, and the six Terminal lifecycle operations. Each record defines effect, current audit state, direct-network behavior, operating-system permissions, policy hooks, cancellation, reversibility, idempotency, data movement, and closed exact input/output shape kinds without redefining capability, application, host, privilege, or mutation authority. Generation embeds a deeply frozen contract table into Core and a separate Android semantic-constant registry. Core enforces authorization, then exact input validation, then dispatch, then exact output and cross-field validation before any success frame. Capability-free `system.ping` returns only `{ok:true}` after trusted session/origin, method-admission, and replay checks; it performs no provider work and makes no health, readiness, privilege, or trust claim. Android consumes the generated URI, network, platform, application, list, renderer, and Terminal bounds; constructs the fixed Android platform variant; rejects invalid provider status rather than truncating it; and reuses one strict mailto canonicalizer at the bridge and system adapter. Validation requires exact cross-host policy coverage and fails closed on unknown fields, authority injection, noncanonical serialization, broadened URI schemes, or changed status meaning. Shared fixtures cover empty parameters and the intentionally narrow printable-ASCII mailto grammar, including encoded controls, malformed escapes, fragments, backslashes, Unicode, and alternate schemes. `network.status.online` means only that a non-loopback interface was observed; it is not Internet or service reachability. `external.open.opened` means only that the operating system accepted the handoff; it does not prove that a composer opened or a message was sent, and simulation returns `EXTERNAL_OPEN_SIMULATED` rather than fabricating success. Non-Terminal records currently use `audit: none`, while Terminal lifecycle records use `audit: metadata`; privacy-safe correlated action-ledger work remains open. Kotlin source/build parity and API 35 instrumentation are verified for this unsigned debug distribution, while production-signed and real-device conformance remain pending.

Arcane Core has a closed method-policy table. A request is accepted only when:

1. The method is known.
2. The active descriptor grants its required capability.
3. The descriptor's application type is allowed for that method.

Provisioning, user management, and session control therefore cannot be reached merely by knowing an RPC method name. A privileged worker loads the same app descriptor and repeats the same check before dispatch, so elevation changes operating-system privilege but not application authority. `Arcane.app.current()` and `Arcane.capabilities.list()` expose the active identity and effective method set to the UI.

## Appearance and Microsoft NT integration

The shared `ThemeManager` owns renderer theme commits. A committed scheme or skin is also sent through the capability-gated `Arcane.appearance` contract; app code never writes the Microsoft NT registry directly. On Microsoft NT, Core's native adapter records the Arcane caption palette, updates both per-user application and system light-theme values, preserves the pre-Arcane values for reversible `system` mode, and broadcasts the standard theme-change notification. Every Arcane native host applies the resulting DWM dark-mode and caption attributes, listens for later user-preference changes, and forwards them through `Arcane.events` as `appearance.changed`.

The Shell's compiled startup surface is the sole pre-verification presentation. It renders a pure HTML document embedded in the signed native host, with no script, external asset, file, registry, WebView2, Core, or application input. The host reports actual directory discovery, retained handles, SHA-256 file/byte verification, bounded Authenticode workers, first-boot work, native form construction, Core startup, WebView2 creation, and verified navigation into that document. Publisher verification still gates every executable release asset and the first-boot pipeline. The embedded boot surface stays visible above the empty native form and is closed only after the verified shell navigation completes successfully.

## Native bridge and renderer boundary

The native webview loads only the packaged application origin. The Microsoft NT bridge exposes the single COM-visible operation `Send(requestJson)`; the Linux host exposes one reply-capable message handler. Neither surface accepts an operating-system command. Navigation outside the selected packaged entry, new-window requests, and untrusted origins are blocked.

The frontend uses a generated default-deny Content Security Policy with hashes for its exact inline scripts and a restrictive Permissions Policy. The built-in shell may request microphone-only access from its trusted origin for voice transcription. The provisioner, camera access, and all other native permission requests are denied.

The experimental Android launcher boundary reuses the same `arcane/1` renderer contract without embedding the desktop Node adapter inside a WebView. The exported Shell activity declares separate explicit-launch and Android HOME/DEFAULT intent filters, making it eligible for the operating system's HOME role without allowing the package to assign that role to itself; a user, device policy, or disposable-emulator setup must still select Arcane as the default home application. `ArcaneWebViewHostController` binds one controller and WebView to one immutable application entry under `https://appassets.androidplatform.net/arcane/`, serves only packaged APK assets, blocks every other main-frame and subresource request, rejects non-GET and traversal-encoded asset requests, disables WebView and service-worker network/file/content access, mixed content, and popup windows, and blanks any unapproved navigation observed at page start. `GeneratedAndroidApplicationRegistry` derives the bundle version plus Shell identity, entry, and Android-compatible grant intersection from the canonical bundle manifest and method policy registry. `ArcaneAndroidHostSession` has no public authority-bearing constructor inputs: its Shell factory consumes that generated record, requires the installed launcher package version to equal the generated bundle version, defensively copies the grants, snapshots only Android release, ABI, and launcher version, deliberately omits WebView patch version, and exposes no mutation path. The controller consumes the same session entry rather than a second caller-supplied value. AndroidX WebKit injects one `arcaneAndroid` message object into the exact origin; the bridge admits only main-frame messages, validates exact bounded requests and replay state, snapshots generated method-specific grants, validates the complete entry-bound application descriptor before provider work, and reports only granted Android methods. Controller lifecycle is one-install: a strong ownership reference and explicit state prevent reuse even if a caller loses its WebView reference. UI-thread-bound close removes the message listener before detaching and destroying the WebView; wrong-thread and partial-destruction results remain retryable, while successful listener removal immediately transitions to an authority-revoked state that rejects further loads. Close reports authority revocation separately from destruction. It does not clear cookies, DOM storage, cache, or service-worker profile data; those persistent same-origin records require a separate launcher storage/retention policy and must not be described as logged out or erased merely because native authority was revoked. The `user.current` method remains capability-gated by `identity.read`. The session snapshots one anonymous `local-session` identity at bridge installation with null username/accountName, generic display text, and no AccountManager, device/profile identifier, UID, or persistent pseudonym. Core separately projects Microsoft NT/Linux native identity to the same public five-field contract while retaining machine/domain details only for internal provisioning. `network.status` preserves the Core contract by counting interfaces with at least one non-loopback address and setting `online` from that count; Android enumerates these through `java.net.NetworkInterface`, exposes no names or addresses, bounds the count, and requires no Android network or location permission. `external.open` has a reviewed host implementation but is not granted to the canonical Shell manifest; if a future signed application manifest grants it, the provider admits only an exact bounded `mailto:` URI, resolves an exported default handler, pins the explicit component, and uses `ACTION_SENDTO`. Other methods and URI schemes fail closed. The current service-worker control requires Android API 24 or later; the future pinned build must declare that minimum explicitly. Generated source authority and package-version binding do not authenticate the APK signer or the runtime package/session. These Kotlin boundaries now have focused source, compilation, instrumentation, and disposable-emulator boot evidence, but dependency provenance, signer authentication, update/recovery, accessibility, and real-device acceptance remain incomplete; this is not yet a production Android launcher release.

Target packaging applies the same boundary to every complete target HTML document. It derives CSP origins from the registered descriptor, hashes allowed inline and component-wrapper scripts, denies remote script execution, emits an explicit navigation-entry allowlist, and verifies every referenced local dependency. A Microsoft NT target build produces an actual WebView2 launcher that consumes the app id, launch entry, and microphone grant; a portable target carries the same policy metadata but no operating-system launcher.

`Arcane.filesystem.selectDirectory()` is the narrow exception for user-chosen local paths. The `filesystem.directory.select` capability opens the native operating-system folder dialog only after a user action and returns either one canonical existing directory or an explicit cancellation. Microsoft NT uses the read-only WinForms folder browser. Linux selects an installed Zenity or KDialog picker according to the desktop environment and invokes it directly with an argument array; it never uses a shell or privilege broker and fails explicitly if neither picker exists. Core canonicalizes and revalidates the returned existing directory. The capability does not enumerate drives, expose directory contents, create folders, or grant storage access. Applications remain responsible for applying their own domain validation to the selected directory.

Android installation returns structured success, cleanup-required, teardown, and error fields. A failure after bridge registration cannot be mistaken for a clean unsupported result; the launcher must retain the controller and retry `close` while cleanup remains required.

The current Android multi-package implementation supersedes the preceding single-Shell packaging and all-network-blocked description. The Launcher APK contains Shell, presentation metadata, shared runtime, and launcher support assets but no registered application payload directories; each registered app is a separate package with an app-specific reserved HTTPS origin, Android UID, storage, and explicit launch intent. Android `INTERNET` is derived from non-empty registered connect/frame/media origins, while generated CSP still restricts the renderer to those origins. Terminal has no `INTERNET` permission and alone composes the bounded app-UID `/system/bin/sh` provider. The local API 35 evidence covers Launcher, installed catalog, Browser home-frame load, and Terminal command output; signer, update/recovery, full accessibility, and real-device acceptance remain open.

## App-scoped storage

`Arcane.storage` is a Core service, not raw filesystem access. Its file is selected from the active app id and the current user's state directory, so callers cannot supply a path or another app id. `storage.read` controls list/get, and `storage.write` controls set/delete.

Keys are validated stable identifiers. Values must be JSON-compatible, are limited to 128 KiB each, and share a 1 MiB per-app quota. Updates use a private temporary file followed by rename, keeping writes atomic.

## Privileged request path

Privileged workers receive a one-use endpoint and session secrets, accept one forwarded allowlisted request, stream progress and the result, and terminate. Production subprocesses use trusted executable locations, safe working directories, and a sanitized environment.

On Microsoft NT, the broker first locates `ArcanePipeGuard.exe` inside the verified release and checks that it and `ArcaneCore.exe` have valid Authenticode signatures from the same certificate. The only exception is explicit controlled-test mode (`--allow-unsigned-local-release`), which accepts an unsigned sibling pair only after both exact files match the schema-2 release manifest. The guard then creates the one-use named pipe with a protected ACL for the broker's user SID, Administrators, and LocalSystem, before Arcane requests UAC. After `Start-Process -PassThru` returns the elevated worker PID, the broker supplies that PID over the guard's private standard input.

The guard opens and holds a handle to the expected process and verifies that the original process is still alive before and during binding, so a recycled PID cannot be accepted. For each connection, it calls `GetNamedPipeClientProcessId` on the server handle and rejects any other kernel-reported PID without relaying application bytes. Only the matched client becomes the opaque full-duplex transport to the JavaScript broker. This prevents a token-aware process from winning the pipe race by merely claiming the expected PID in its hello frame.

The broker creates an ephemeral Ed25519 signing key and X25519 exchange key. The worker contributes a claimed process id, random nonce, and its own ephemeral X25519 key. The broker requires both the claimed id and the guard's kernel-reported id to equal the process id returned by the UAC launch. Its signature binds the broker session and process, expected/claimed worker process, application, platform, version, worker nonce, exact request id/method/SHA-256, and both exchange keys. The worker verifies that signed binding before dispatching anything.

Both peers derive directional keys from X25519 with HKDF-SHA-256. Every post-handshake broker-to-worker request and worker-to-broker event/response is wrapped with AES-256-GCM; authenticated context includes its direction and monotonic sequence. Frames are encrypted on the wire, and modified, reordered, or replayed frames fail channel authentication after the exchange completes.

The Ed25519 direction authenticates the broker and exact request to the worker. On Microsoft NT, `GetNamedPipeClientProcessId` provides the reciprocal worker identity before the broker parses the hello, while the signature and AES-GCM channel bind the exact request and subsequent frames to that verified session.

Linux has no equivalent guard in 0.8.4. Non-simulated automatic privileged requests fail with `PRIVILEGE_PEER_VERIFICATION_UNAVAILABLE`; the adapter does not invoke PolicyKit or sudo while its Unix-domain socket lacks enforced `SO_PEERCRED` verification. Simulated elevation remains available only for portable protocol and transaction tests.

## Runtime prerequisite policy

Runtime requirements are platform- and scope-aware. The packaged Core does not need a separate Node installation, so Node.js is nonblocking. The native renderer and session-control capability are required for base installation on both desktop kernels. Ollama remains required on Microsoft NT and before Arcane-user provisioning; Microsoft NT may use only the verified official-archive action to install or repair its protected machine service. Linux and WSL treat Ollama as nonblocking for base Arcane OS installation but still require a healthy machine-wide service before local-AI use. Linux third-party prerequisites remain detection-only and administrator-managed: Arcane performs no package-manager installation, and an administrator installs them through a trusted operating-system or vendor channel before asking Arcane to check again.

## Core platform-adapter registry

Core selects native adapters through the explicit frozen registry in `src/native/platform-adapters.cjs`. The registry contains exactly `win32` and `linux`; it has no default adapter and does not alias platform names. Unknown real hosts and unsupported, duplicate, conflicting, or out-of-mode simulation platform requests exit before Core begins RPC listening. Android is intentionally absent because its WebView host/service boundary does not inherit the desktop Node process, account, shell, elevation, or installation model.

Simulation may select only the exact registered Core platforms and never converts an Android bridge test into desktop-host evidence. Packaged Core ignores simulation environment controls as before, while source simulation requires an explicit simulation mode and one unambiguous platform value.

## Account staging and shell recovery

Linux user provisioning reuses the same `users.manage` capability and staged credential transaction through the Linux System Platform Adapter. A regular Linux session can validate and inspect the workflow but cannot mutate the machine. A separately authorized root Provisioner rejects the active provisioning identities, UID 0, service/system UIDs, and privileged-group accounts; stages new accounts locked and expired; durably binds account activation and rollback to the exact UID; preserves existing passwords and memberships; and verifies the POSIX shell before assignment or restoration. The root-owned Arcane shell shim launches the graphical Shell only with `DISPLAY` or `WAYLAND_DISPLAY` and otherwise delegates to `/bin/bash` or `/bin/sh` so console and SSH recovery remain possible.

A fresh verified Linux install registers a root-owned X11 display-manager entry that launches the fullscreen Arcane session wrapper as the authenticated user. Its explicit release policy sets `graphical.target` only after systemd, display-manager, session-file, ownership, mode, and postcondition checks; the prior target is retained for rollback. Updates and repairs preserve an administrator's later target choice. WSLg remains per-application manual-launch mode and receives no boot-target mutation, while its already-root Provisioner can still perform the platform's account transaction. Arcane does not register a Wayland session because it does not supply a compositor.

Before assigning Arcane as a Microsoft NT user's shell, the adapter records whether the per-user Winlogon `Shell` value existed and its value. Restoring an absent value removes the override and returns the account to the Microsoft NT default shell. Restoration verifies that Arcane is still the current shell, preventing Arcane from overwriting an unrelated administrator change.

New accounts on both desktop kernels follow a durable two-request transaction. Microsoft NT records an exact SID and two shell bindings; Linux records an exact UID and one POSIX shell binding:

1. `users.add` writes a prepared recovery record, creates the standard account disabled, records its exact SID or UID, initializes its profile or home, assigns Arcane as its shell, and writes `activation-pending` state.
2. `users.add` returns the temporary password while the account is still disabled.
3. Only a later explicit `users.activate` request enables the account and marks activation complete.

Failures before credential delivery roll back shell changes and remove a newly created account only after exact stable-identity verification. If the process is lost before the SID or UID can be durably recorded, recovery fails closed with the account disabled and requires administrator review rather than deleting by username. Failures during or immediately after enablement keep a retryable activation journal; a later `users.activate` reconciles the real enabled state safely. For existing accounts, passwords and memberships are preserved, and rollback remains scoped to Arcane's shell assignment. `users.restoreShell` remains the explicit operator recovery action.

Resetting an active Arcane user's password uses a separate credential-first handoff. `users.resetPassword` is non-privileged and only generates a temporary password for the UI to display; it does not touch the operating-system account. After the operator saves that value, `users.applyPassword` performs the privileged Microsoft NT password change using the exact supplied credential over protected standard input and marks it for change at next sign-in. This ordering leaves the old password intact if the first phase or UI is interrupted and ensures that a credential is already available if the apply phase is interrupted after Microsoft NT accepts the change.

## Release integrity and repair

Release schema 2 inventories every distribution file except the manifest itself. Each entry contains a normalized relative path, byte size, and SHA-256 hash. The inventory includes native executables and libraries (including `ArcanePipeGuard.exe` on Microsoft NT), `arcane-bundle.json`, the shared API, and every provisioner and shell asset. Extra files, missing files, symbolic links, unsafe paths, size changes, and hash changes fail closed.

Installation follows a staged transaction:

1. Verify the source release's exact inventory and platform/version metadata.
2. Copy into a separate stage and verify the mapped staged files.
3. Generate an exact installed-tree integrity inventory.
4. Move the prior installation to a backup and activate the stage.
5. Verify the activated tree and apply platform permissions.
6. Remove the backup only after success; otherwise restore it.

Normal status checks verify the installed tree. If the installed version matches the bundle but its layout or integrity does not, the provisioner performs a same-version repair from a verified release.

The SHA-256 manifests detect accidental or local tree modification but do not authenticate a publisher by themselves. Repository-produced Microsoft NT binaries are unsigned controlled-local-build artifacts unless a code-signing certificate is configured. The explicit unsigned-local override is manifest-bound but is not publisher authentication. Production builds must Authenticode-sign and timestamp the provisioner, shell, Core, pipe guard, and Microsoft NT target executables, and should fail the build when signing is unavailable; at runtime, the Core refuses to launch a guard signed by a different certificate.

## Targeted app packages

`arcane-apps.json` registers generic non-privileged apps with an explicit source, entry point, capability list, security-origin policy, and payload include list. `npm run build:app -- --app=<id>` selects exactly one descriptor and writes `dist/targets/<id>/` atomically. `npm run build:apps` and `npm run build:apps:portable` build every registered target as portable verification packages; `npm run build:apps:windows` wraps every target with a native Microsoft NT launcher.

An app may declare `bundledApps` when it composes another registered app's authoritative runtime, such as a white-label shell. The packager validates an acyclic, self-free dependency graph, requires the outer app's capabilities and connect, frame, and media origins to cover every direct dependency, rejects generated document-catalog dependencies, and copies each transitive dependency from its own source and positive include list into a separate package root. URL relocation and link verification admit only those declared roots; undeclared cross-app references still fail closed. `web.embed` with no `frameOrigins` means same-origin frames only, while omitting `web.embed` keeps `frame-src 'none'`.

The packager rejects traversal, absolute or platform-specific paths, symbolic links, overlapping includes, reserved ids, privileged app types, wildcard security origins, and capabilities outside the approved generic set. The output contains only the selected app, its explicitly bundled registered app roots, and shared allowlisted files, plus an injected `arcane-api.js`, an app-specific Core and bundle descriptor, generated renderer security metadata, and an exact deterministic `arcane-app-package.json` SHA-256 inventory.

Portable output is intentionally launcher-free. Microsoft NT output contains `ArcaneApp-<id>.exe`, a packaged target-specific `ArcaneCore.exe`, `ArcanePipeGuard.exe`, the WebView2 dependencies, and a start script. The shared Microsoft NT host loads only the descriptor's exact generated navigation entries and packaged origin, enforces the injected CSP/Permissions Policy, and applies the descriptor's microphone decision.

Source document corpora do not cross the default package boundary. The BOSS 0.8.3 target emits only an `empty-unpublished` zero-record catalog and includes no Markdown corpus. A future export requires separate publication authorization and may admit only public, non-sensitive records; a source `access` label by itself is not publication authorization.
