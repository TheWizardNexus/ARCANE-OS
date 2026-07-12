# Arcane OS Machine Bundle 0.8.2

Arcane 0.8.2 uses native application windows and private process IPC instead of a browser-and-localhost production architecture.

- **Windows:** `ArcaneProvisioner.exe` and `ArcaneShell.exe` own native WinForms windows and embed Microsoft Edge WebView2.
- **Linux:** `ArcaneProvisioner` and `ArcaneShell` own GTK 4 windows and embed WebKitGTK 6.0. Real account/shell provisioning is disabled until Arcane has a display-manager-safe Linux session integration.
- **Shared backend:** `ArcaneCore` is the packaged Node runtime that normalizes machine operations through Windows and Linux adapters.
- **Frontend contract:** both SPAs import the same external `arcane-api.js` and only use `window.Arcane`.
- **Per-application policy:** each packaged application has a type and an explicit capability allowlist. Arcane Core rejects methods that the active application was not granted, including after privilege elevation.
- **Production transport:** no localhost HTTP server and no browser process. Native hosts communicate with Arcane Core using framed JSON over redirected standard input/output.
- **Privileged work:** on Windows, the normal GUI remains open and unelevated while Arcane launches a short-lived UAC worker. `ArcanePipeGuard.exe` admits only the kernel-reported named-pipe client PID returned by the UAC launch; the worker also verifies a broker signature over the exact request/session binding, and all post-handshake request, event, and response frames use an encrypted, integrity-checked channel. Automatic Linux administrator brokering is disabled until an equivalent kernel peer-credential guard exists.

## Frontend-to-native call path

```text
SPA
  window.Arcane.users.add(["arcane1"])
        │
        ▼
shared/arcane-api.js
        │
        ├─ Windows: WebView2 host object
        ├─ Linux: WebKitGTK reply-capable message handler
        └─ Development only: local HTTP bridge
        │
        ▼
Native Arcane window host
        │ framed arcane/1 RPC over child stdio
        ▼
Arcane Core (Node)
        │
        ├─ Windows native adapter
        └─ Linux native adapter
```

The web UI never calls PowerShell, registry tools, `useradd`, `pkexec`, UAC, or session commands directly.

## Public Arcane API

```js
await Arcane.app.current();
await Arcane.capabilities.list();
await Arcane.version.current();
await Arcane.system.ping();

await Arcane.platform.status();
await Arcane.permissions.status();
await Arcane.machine.status();
await Arcane.user.current();
await Arcane.system.metrics();
await Arcane.network.status();

await Arcane.requirements.list();
await Arcane.requirements.ensure();
await Arcane.installation.status();
await Arcane.installation.ensure();

await Arcane.users.validate(["arcane1"]);
await Arcane.users.add(["arcane1"]);
await Arcane.users.activate("arcane1");
await Arcane.users.list();
const prepared = await Arcane.users.resetPassword("arcane1");
await Arcane.users.applyPassword("arcane1", prepared.credentials[0].temporaryPassword);
await Arcane.users.restoreShell("arcane1");

await Arcane.storage.list();
await Arcane.storage.get("editor.document.current");
await Arcane.storage.set("editor.document.current", { markdown: "# Draft" });
await Arcane.storage.delete("editor.document.current");

const applications = await Arcane.applications.list();
await Arcane.applications.launch(applications.applications[0].id);

await Arcane.provisioning.plan(["arcane1"]);
const recent = await Arcane.diagnostics.recentErrors();
await Arcane.diagnostics.get(recent[0].id);

await Arcane.system.lock();
await Arcane.session.logout();
```

The API is defined in `src/frontend/shared/arcane-api.js`. This is the union of the typed API surface; an application can call only methods allowed by its descriptor. Applications should never use `chrome.webview`, `window.webkit`, PowerShell, or Linux commands outside that transport module.

## Application capabilities and storage

The built-in `provisioner` and `shell` descriptors live in `arcane-bundle.json`. Target applications are registered in `arcane-apps.json`. Arcane Core maps every callable method to a required capability and, for sensitive operations, an allowed application type. Generic applications cannot grant themselves `users.manage`, `provisioning.manage`, or session-control methods. The same authorization check runs in an elevated worker, so elevation cannot widen an application's authority.

`Arcane.storage` is per-user and per-application. It accepts JSON-compatible values, writes them atomically to the user's Arcane state directory, limits one value to 128 KiB, and limits an application's total storage to 1 MiB. `storage.read` and `storage.write` are separate grants, and one application cannot select another application's storage file.

Renderer permissions are a second boundary. The built-in native hosts allow microphone access only to the trusted packaged shell origin for voice transcription. The provisioner, camera access, untrusted navigation, and other permission requests are denied. Windows does not persist the decision in the WebView profile. Every target package receives a generated default-deny Content Security Policy, a restrictive Permissions Policy, and an explicit navigation-entry allowlist. Windows native target launchers enforce the packaged origin and the target's `media.microphone` grant; portable packages contain the same policy metadata but no operating-system launcher.

## Privilege model

A machine-changing method such as:

```js
await Arcane.installation.ensure();
```

is one request from the UI. On Windows, Arcane Core determines whether elevation is required. When it is:

1. The normal Arcane GUI remains open.
2. Arcane starts `ArcanePipeGuard.exe`, which creates a one-use named pipe protected for the current Windows identity, Administrators, and LocalSystem, then creates session secrets and ephemeral signing and key-exchange material.
3. Windows launches `ArcaneCore.exe` using UAC and returns the worker PID. Arcane supplies that PID to the guard over its private standard input.
4. The guard calls `GetNamedPipeClientProcessId`, rejects clients whose kernel-reported PID differs from the UAC launch result, and relays bytes only for the verified worker.
5. The worker sends its claimed process id, nonce, and ephemeral X25519 public key. The broker requires the claim and kernel-verified identity to match the launch result, then signs the session, process identities, application identity, request id/method/hash, nonce, and both exchange keys with Ed25519; the worker verifies that binding before accepting the request.
6. Both sides derive directional keys with X25519 and HKDF. The original request is forwarded in an AES-256-GCM frame with authenticated direction, context, and sequence.
7. Progress and the final result return through encrypted, authenticated worker-to-broker frames to the same frontend promise, then the worker and guard exit.

There is no elevated provisioner window, no second Install click, and no GUI handoff.

Linux 0.8.2 deliberately fails automatic privileged requests with `PRIVILEGE_PEER_VERIFICATION_UNAVAILABLE`. It does not invoke PolicyKit or sudo because the JavaScript Unix-socket broker does not yet enforce an `SO_PEERCRED`-equivalent worker identity. Linux simulation still exercises the protocol without changing a machine.

## 0.8.2 Windows bridge correction

Version 0.8.2 fixes the WebView2 startup failure reported as `Unknown name. (0x80020006)`. The bridge now exposes `Send(requestJson)` instead of the COM-reserved `Invoke` name. The Windows build verifies the real compiled `IDispatch` surface in both executables, and frontend diagnostics retain the native HRESULT and method if a bridge call fails.

## 0.8.1 Windows build correction

Version 0.8.1 fixes the C# `CS0051` failure from 0.8.0. The COM-visible `ArcaneBridge` remains public for WebView2, while its constructor is internal because it receives the private `ArcaneCoreProcess` implementation. The Windows build now runs this accessibility preflight before packaging `ArcaneCore.exe`, so the same source regression fails immediately with a direct explanation.

## Windows build

Requirements for building:

- Windows 10 or 11 x64
- Node.js 22 or newer
- npm and internet access for build-time dependency acquisition
- Windows .NET Framework 4.x C# compiler

Run:

```bat
build-windows.bat
```

The build:

1. Generates the shared Arcane Core and local app payload.
2. Packages Arcane Core as `dist\windows\bin\ArcaneCore.exe`.
3. Acquires the exact pinned Microsoft WebView2 SDK from NuGet when it is not already cached and verifies its configured SHA-256 before use.
4. Compiles icon-bearing native GUI applications:
   - `dist\windows\bin\ArcaneProvisioner.exe`
   - `dist\windows\bin\ArcaneShell.exe`
5. Compiles `dist\windows\bin\ArcanePipeGuard.exe` and runs a real named-pipe adversarial test proving that a client which merely claims the expected PID is rejected while the kernel-matched client is relayed.
6. Copies the WebView2 loader and managed assemblies.
7. Writes `dist\windows\arcane-release.json` with the exact release inventory, byte sizes, and SHA-256 hashes for every executable, library, manifest, and application asset.

Start the provisioner:

```bat
start-provisioner.bat
```

Safe simulation:

```bat
start-provisioner-simulation.bat
```

Runtime prerequisites are administrator-managed. Arcane verifies the installed WebView2 Runtime and native session-control capability, but all declared third-party requirements are `installable: false`; `requirements.ensure` reports a blocked prerequisite instead of downloading or executing an installer. The packaged Core does not require a separately installed Node.js, and Ollama is optional. Install missing components manually from a trusted operating-system or vendor channel, then choose **Check again**.

Production builds require `ARCANE_SIGNING_CERT_THUMBPRINT` and `ARCANE_TIMESTAMP_SERVER`; the build fails unless every executable is signed by the same publisher and timestamped. Before starting the pipe guard, Arcane requires `ArcaneCore.exe` and `ArcanePipeGuard.exe` to have valid Authenticode signatures from the same certificate. Unsigned artifacts are suitable only for controlled local testing and privileged operations refuse them by default; use `npm run build:distribution:windows:unsigned-local-test`, then explicitly launch `dist\windows\bin\ArcaneProvisioner.exe --allow-unsigned-local-release`. That switch accepts only an unsigned Core/guard pair whose sibling files still match the exact schema-2 release manifest. Never distribute a build using this override. Production/distribution builds must Authenticode-sign and timestamp `ArcaneProvisioner.exe`, `ArcaneShell.exe`, `ArcaneCore.exe`, `ArcanePipeGuard.exe`, and every distributed `ArcaneApp-<id>.exe` with a trusted publisher certificate.

Production publisher identity is independently anchored with `ARCANE_EXPECTED_PUBLISHER_THUMBPRINT`. It must be configured separately and exactly match `ARCANE_SIGNING_CERT_THUMBPRINT`; signed builds and verification fail if the trust anchor is absent or different.

## Linux build

Build dependencies vary by distribution. Debian/Ubuntu example:

```bash
sudo apt install build-essential libgtk-4-dev libwebkitgtk-6.0-dev
```

Then:

```bash
./build-linux.sh
./start-provisioner.sh
```

The Linux host uses GTK 4 and WebKitGTK 6.0. Its non-privileged status, renderer, shell, session-control, and simulation paths remain available. Automatic machine-changing requests fail closed in 0.8.2 instead of invoking PolicyKit or sudo because the Unix-socket worker has no enforced kernel peer-credential check yet.

Linux requirements are also administrator-managed; Arcane does not run a package manager or remote installer at runtime. Install GTK/WebKitGTK and any optional Ollama runtime from the distribution or a verified official package. Real account creation and login-shell replacement are intentionally unavailable on Linux in 0.8.2; use the supported Windows provisioner for machine accounts. Simulation still exercises the transaction logic without changing a machine.

## Development browser fallback

Production does not use a server. A localhost bridge exists only so the same SPA can be developed in an ordinary browser:

```bash
npm run dev:provisioner
npm run dev:shell
```

The development bridge uses the same `arcane/1` envelopes and the same `window.Arcane` API.

## Provisioning behavior

**Install Arcane OS** performs the entire install/update/repair flow:

- Blocks downgrade attempts when the globally installed Arcane version is newer than the package.
- Installs Arcane when absent.
- Updates an older Arcane installation.
- Verifies the native renderer and session control, while reporting optional Node.js and Ollama status when present.
- Never downloads or installs third-party runtime prerequisites; missing required capabilities block the operation with manual remediation guidance.
- Rejects any release whose exact file inventory, size, or SHA-256 does not match `arcane-release.json`.
- Stages and verifies native executables and all app assets before activation, then swaps the installation atomically and restores the previous installation if activation fails.
- Records an exact installed-tree integrity inventory and performs a verified same-version repair when files are missing, changed, or unexpected.

**Create Arcane user** is supported for real accounts on Windows and intentionally uses a two-step credential-delivery and activation flow:

- Ensures Arcane and its requirements are ready.
- Creates each missing account as a disabled standard user and records its exact Windows SID.
- Preserves existing account passwords and memberships.
- Captures the account's prior shell state before assigning Arcane.
- Assigns Arcane as the selected account's shell.
- Protects the account running the provisioner from shell replacement.
- Returns the new temporary password while the account remains disabled and durably marked `activation-pending`.
- Enables a staged account only after the operator has saved the credentials and explicitly selects **Activate staged users**, which calls `Arcane.users.activate(username)` separately.
- Offers **Restore previous shell** for Arcane-managed accounts and verifies the restored state.
- Journals preparation, shell assignment, account staging, activation, and rollback so interrupted work can be recovered or failed closed.
- Before credential delivery, rolls back a newly created account only when its exact recorded SID still matches. A crash before the SID is durably known leaves the account disabled and requires administrator review rather than deleting by username.
- After credential delivery, activation failures retain a retryable staged record; repeated `users.activate` reconciles whether Windows enabled the account before the interruption.
- Refreshes the Arcane user list after completion.

For an active Arcane account whose password is unknown, use **Set temporary password** in the Arcane users list. This first `users.resetPassword` request only generates and displays a credential; it does not change the operating-system password. Save the credential, then explicitly select **Apply saved password**, which makes the separate privileged `users.applyPassword` request and requires the password to be changed at next sign-in. A failure before that second request leaves the existing password untouched; if the apply request is interrupted after Windows changes the password, the operator already has the credential needed to recover.

For pre-existing accounts, rollback is intentionally scoped to the shell assignment and does not reverse a separately requested password reset. Arcane also refuses to overwrite a shell changed outside Arcane after provisioning. Linux exposes no real `users.add` or `users.activate` account workflow in this release.

## Targeted application packages

`arcane-apps.json` is the registry for generic non-privileged Arcane applications. Each entry defines the app id, display name, source directory, HTML entry point, capability allowlist, and explicit payload allowlist. The current registry contains `precrisis` and `boss`.

```bash
npm run build:app -- --list
npm run build:app -- --app=precrisis
npm run build:app -- --app=boss
npm run build:apps:portable
npm run build:apps:windows
```

Packages are written atomically to `dist/targets/<app-id>/`. Each target contains only its allowlisted app and shared payload, an injected Arcane runtime API, an app-specific Core and bundle descriptor, and `arcane-app-package.json` with an exact deterministic SHA-256 inventory. The packager rejects unknown apps, unsafe or escaping paths, symbolic links, overlapping payload rules, privileged app types, and capabilities outside the approved non-privileged set. It also rewrites package-relative URLs, verifies all local dependencies, injects the target CSP/Permissions Policy into every navigable document, and records the navigation allowlist.

`build:apps`, `build:apps:portable`, and `--platform=portable` produce cross-platform verification packages without a native executable. On Windows, `build:app` defaults to `--platform=windows`; `build:apps:windows` produces actual `ArcaneApp-<id>.exe` WebView2 launchers, packaged `ArcaneCore.exe` and `ArcanePipeGuard.exe`, and the WebView2 assemblies. Each native target package has an exact root inventory and intentionally contains no mutable batch launcher. The launcher permits only the generated exact navigation entries and applies the target's CSP, Permissions Policy, and microphone grant. Build the Windows release first so the pinned, verified WebView2 SDK is present in the build cache.

Application source corpora are outside the default target boundary. In 0.8.2, the BOSS package emits an `empty-unpublished` document catalog with zero records and no Markdown documents. A later corpus export may include only records that receive separate publication authorization and are both public and non-sensitive; classification metadata alone is not publication permission.

## Diagnostics

User-facing errors include a plain-language cause and next step. **See full diagnostics** reveals the structured diagnostic record. **Copy full diagnostics** and temporary-credential copy actions provide visible `Copied ✓` feedback.

Arcane Core reserves stdout exclusively for framed RPC. Technical logs go to stderr. The Windows native host writes Core stderr to:

```text
%LOCALAPPDATA%\Arcane OS\logs\
```

## Verification

Run the canonical bundle gate:

```bash
npm run check
```

It builds generated assets, runs source verification, all smoke tests, the app-packager test suite, and portable target builds with exact inventory verification. From the repository root, `npm run check` also runs every shared Arcane test before delegating to this bundle. `npm run hooks:install` configures the repository's pre-push hook; on Windows, `npm run prepush` runs the portable gate and then compiles and verifies the complete Windows release, the real kernel-PID pipe guard, both native app targets, and the compiled dispatch contracts. The `Arcane checks` GitHub Actions workflow repeats those portable and native Windows gates on every push and pull request.

The portable tests exercise framed RPC, capability denial, app-scoped storage, staged-account transaction/crash recovery, the two-request password-reset handoff, shell restoration, release and installed-tree tamper detection, runtime isolation, command hardening, broker identity/signature rejection, the encrypted privilege channel, and the fail-closed Linux privilege boundary without installing software, changing real accounts, assigning a real shell, or logging out. The Windows build additionally runs the compiled kernel-PID pipe-guard test. See `VALIDATION.md` for the exact automated and target-only portions.
