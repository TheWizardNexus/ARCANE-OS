# Changelog

## 0.8.4

- Paints a compiled, pure-HTML Arcane Shell boot screen before publisher verification and reports live directory, retained-handle, SHA-256 byte/file, Authenticode executable, first-boot, Core, WebView2, and verified-navigation progress until the real shell renders.
- Adds capability-gated `Arcane.appearance.current()` and `Arcane.appearance.apply()` APIs that synchronize Arcane scheme and caption colors with per-user Microsoft NT personalization.
- Applies dark/light DWM chrome to every Arcane native window and refreshes open hosts when Microsoft NT broadcasts an appearance change.
- Adds one shared certificate-store signer plus preflighted release, all-app, and single-app build commands, with SHA-256 Authenticode, RFC 3161 timestamps, exact publisher verification, and no repository-managed private keys.
- Adds a one-command, per-developer Microsoft NT signing bootstrap that creates a non-exportable local certificate and produces double-clickable builds without the unsigned-local launch argument.
- Publishes Microsoft NT machine releases under canonical `dist/nt` and fails closed instead of discovering stale `dist/windows` or flat `dist` payloads; technical `windows` and `win32` compatibility identifiers remain unchanged.
- Adds a first-install-only Linux X11 display-manager session policy with WSLg manual-launch detection, systemd/display-manager/session preflight, exact `graphical.target` postcondition verification, prior-target persistence, and installation rollback.
- Decouples base Linux and WSL installation from Ollama while preserving Microsoft NT Arcane-user requirements: Linux reports Ollama as a nonblocking prerequisite that must be completed before local-AI use.
- Makes Linux release verification descriptor-rooted and bounded, keeps installation staging private and identity-bound with unrounded device/inode checks, byte-copies only manifest-listed content into fresh root-owned files, rejects links/special files/extra topology, canonicalizes exact `0755`/`0644` modes, and re-proves the stage identity after activation.
- Removes PATH-selected recursive Linux permission commands, applies protected state modes through identity-checked no-follow handles, validates privileged executable aliases, canonical targets, and directory ancestry, and safely considers a later protected system candidate when an earlier candidate is unsafe.
- Adds credential-free Microsoft NT and experimental unsigned-local Linux first-user walkthroughs with staged-account, separate-activation, sign-in, console/SSH, WSLg, existing-password, and shell-recovery guidance.

## 0.8.3

- Added the Arcane Settings AI manager for Ollama and OpenAI provider selection, account-driven OpenAI model selection, and protected per-user API-token storage.
- Added custom Arcane brain creation from any valid Ollama base model, global model-store verification, visible download/build progress, default-model selection, and boot preloading.
- Added GPU-aware Arcane 20B/120B selection and asynchronous Provisioner/Shell boot reconciliation.
- Added bounded per-user context/keep-alive controls and advanced Microsoft NT ArcaneOllama service settings with restart and health verification.
- Added an extensible, per-user first-boot pipeline to the installed Microsoft NT Arcane Shell.
- Moved the Arcane lock/sign-in background into the verified Program Files payload and set it once per user through the supported Microsoft NT lock-screen API.
- Restricted first-boot execution to the canonical installed Shell so development and portable launches cannot change personalization or consume completion markers.

## 0.8.2

- Renamed the Microsoft NT WebView2 bridge entry point from `Invoke` to `Send`; `Invoke` conflicts with COM `IDispatch::Invoke` and produced `0x80020006` before the first request reached Arcane Core.
- Added source-pair and compiled `IDispatch` checks so the frontend and both Microsoft NT executables must expose the same callable bridge method.
- Preserved native bridge HRESULT, method, transport, and technical details in frontend diagnostics.
- Added a Send-only frontend bridge smoke test and made simulated Linux session control portable across build hosts.
- Added per-application descriptors and a server-side method/capability allowlist. Privileged provisioner methods remain restricted by both capability and application type, and elevated workers repeat the same authorization check.
- Added typed app identity, capability discovery, user identity, system metrics, network status, provisioning-plan, and app-scoped storage APIs. Storage uses separate read/write grants, atomic per-user files, validated keys, a 128 KiB value limit, and a 1 MiB per-app quota.
- Restricted native renderer navigation and permissions to the packaged application origin. The built-in shell may use the microphone for voice transcription; the provisioner, camera access, and other permission requests are denied.
- Added an Ed25519 signature over the broker session, expected/claimed worker process, application identity, worker nonce, request hash, and ephemeral exchange keys. Post-handshake requests, progress events, and responses now use directional X25519/HKDF-derived AES-256-GCM frames, and adversarial smoke tests reject a disclosed-token client that claims a different process id plus an invalid broker signature.
- Added the native Microsoft NT `ArcanePipeGuard.exe`: it protects the privilege pipe with explicit ACLs, holds and rechecks the original worker process against PID-reuse races, uses `GetNamedPipeClientProcessId` to reject a client whose kernel PID differs from the UAC launch result even when its hello claims the expected PID, and relays bytes only after that check. The Core requires a matching valid Authenticode signer for itself and the guard; the explicit unsigned-local test override still binds both sibling files to the exact release manifest. Microsoft NT release and target builds compile, inventory, optionally sign, and execute an adversarial test against the guard.
- Disabled non-simulated automatic Linux administrator brokering until the Unix-socket path enforces an `SO_PEERCRED`-equivalent peer identity; Arcane now fails closed instead of invoking PolicyKit or sudo.
- Limited real account and Arcane-shell provisioning to Microsoft NT; Linux then failed closed until a display-manager-safe Arcane session integration existed.
- Added native Linux account provisioning after that display-manager/session boundary became available: root-only staged creation keeps new accounts locked and expired through credential delivery, exact-UID checks bind activation and rollback, protected/system/privileged accounts fail closed, existing passwords and groups are preserved, and the graphical shell shim falls back to Bash or `sh` without a display.
- Reworked new Microsoft NT accounts into a durable staged transaction: `users.add` creates the account disabled, records its exact SID and recovery phases, and returns its temporary password before the separate `users.activate` request may enable it. Existing account passwords and memberships remain unchanged.
- Split existing-account password reset into a credential-first transaction. `users.resetPassword` now prepares and returns a temporary credential without changing Microsoft NT; after the operator saves it, the separate privileged `users.applyPassword` request sends that value on protected standard input, applies it, and marks it for change at next sign-in.
- Added account failure/crash injection across creation, profile initialization, shell assignment, durable state, pending activation, activation, and post-enable boundaries. Recovery uses exact-SID rollback, never deletes by username alone, preserves a disabled partial account for administrator review when identity is uncertain, and safely retries interrupted activation.
- Captured the previous Microsoft NT shell before Arcane assignment, added verified `users.restoreShell` support and provisioner UI, and retained scoped shell rollback for existing accounts.
- Expanded release schema 2 to hash the exact distribution inventory, including every application asset, and added source, staged, activated, and full installed-tree integrity checks. Same-version damage now triggers verified repair, while failed installation activation restores the prior verified installation.
- Made every runtime prerequisite administrator-managed and non-installable. The provisioner detects required WebView/session capabilities and optional Node.js/Ollama installations but performs no third-party runtime download, package-manager operation, or installer execution.
- Added `arcane-apps.json` and portable versus Microsoft NT-native target commands for isolated PreCrisis and BOSS payloads. Packages validate containment, explicit include lists, approved non-privileged capabilities, symbolic-link safety, relocated local URLs, exact dependencies, and deterministic inventories before atomic replacement.
- Added validated `bundledApps` target composition so a white-label app can package another registered app's authoritative allowlist without source duplication; dependency graphs, capability/origin containment, URL roots, and same-origin frame policy remain fail-closed.
- Generated a target-specific default-deny CSP, Permissions Policy, inline-script hashes, and navigation allowlist for every packaged HTML document.
- Added actual Microsoft NT WebView2 target launchers (`ArcaneApp-<id>.exe`) with a target-specific Core, pipe guard, WebView2 dependencies, exact navigation-entry/origin enforcement, injected CSP/Permissions Policy, and descriptor-controlled microphone access. Portable packages remain launcher-free verification artifacts.
- Kept source document corpora outside the default package boundary. BOSS emits an `empty-unpublished` zero-record catalog and no Markdown documents; future public, non-sensitive records still require separate publication authorization.
- Added canonical portable and compiled Microsoft NT gates for the bundle and repository, a repository pre-push hook that runs both, and a Microsoft NT GitHub Actions workflow that repeats the shared, bundle, native release, target-app, pipe-guard, and dispatch checks.
- Hardened production command resolution, subprocess environments, state permissions, credential transport, and Microsoft NT shell emergency recovery.
- Added optional local Authenticode signing plus a production distribution mode that requires a trusted certificate, a timestamp server, and verified timestamps on every executable. Unsigned repository artifacts remain controlled local builds.

## 0.8.1

- Fixed the Microsoft NT WebView2 host build failure caused by a public `ArcaneBridge` constructor accepting the internal `ArcaneCoreProcess` type.
- Kept `ArcaneCoreProcess` private to the native host implementation while allowing the host to construct the COM-visible bridge internally.
- Added a Microsoft NT host source preflight so this accessibility regression is reported before packaging the Node core.

## 0.8.0

- Replaced production Edge app-mode/browser windows with native WebView hosts.
- Added a Microsoft NT WebView2 host with Arcane executable/window icon and AppUserModelID.
- Added Linux GTK 4 + WebKitGTK 6.0 host.
- Added one normalized external `window.Arcane` API for both renderers.
- Added framed `arcane/1` JSON RPC over native-host/Node child-process stdio.
- Added an automatic privileged-worker broker using Microsoft NT named pipes or Linux Unix-domain sockets.
- Removed GUI restart, duplicate elevated window, port collision, browser transfer, and second-click elevation flows.
- Added one-request install/update/repair and one-request Arcane user provisioning.
- Retained downgrade protection, protected provisioning account, user listing, temporary password reset, friendly errors, full diagnostics, and copy feedback.
- Added verified Microsoft NT and Linux release manifests with SHA-256 hashes.
- Kept the HTTP bridge only as a development fallback.
