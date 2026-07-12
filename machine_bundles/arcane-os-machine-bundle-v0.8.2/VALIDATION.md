# Arcane OS 0.8.2 Validation Record

The canonical portable bundle gate is:

```bash
npm run check
```

It generates the Core and application payloads, runs source verification and the full smoke suite, tests the target packager, builds every registered target with `--platform=portable`, and verifies each exact target inventory. From the repository root, `npm run check` first runs every shared Arcane test and then invokes this bundle gate. The repository pre-push hook runs that portable command followed by `npm run check:windows`, which compiles and verifies the Windows release, the real pipe guard, native app targets, and dispatch contracts. The `Arcane checks` GitHub Actions workflow repeats the portable and native Windows gates for pushes and pull requests.

The automated 0.8.2 coverage includes:

- Generating `runtime/arcane-core.cjs` and the built provisioner and shell payloads from their shared sources.
- Parsing the generated Core, external `arcane-api.js`, and every inline SPA script.
- Verifying the WebView2 `Send(requestJson)` transport, preservation of native bridge diagnostics, the Windows host source preflight, and compiled COM `IDispatch` names when a Windows native build runs.
- Exercising framed `arcane/1` RPC and the simulated non-elevated-to-privileged flow, including automatic continuation of the original request.
- Rejecting a disclosed-token first client that claims a different process id and rejecting an invalid broker signature. The successful protocol path uses the source implementation's signed session/request/key binding and X25519/HKDF-derived AES-256-GCM request, event, and response frames.
- Verifying the Windows privilege boundary source/build contract: `ArcanePipeGuard.exe` must be compiled, inventoried, and used before the Node broker accepts a worker; production Core/guard executables must share one valid Authenticode signer, while the explicit `--allow-unsigned-local-release` test mode still requires an unsigned sibling pair bound by the exact schema-2 release manifest. Linux automatic elevation must fail closed while no `SO_PEERCRED` guard exists. Each Windows native build also runs the compiled guard against an attacker that claims the legitimate worker PID, proves `GetNamedPipeClientProcessId` rejects it, and confirms that only the kernel-matched client bytes are relayed.
- Confirming per-application capability grants and denials, including denial of provisioner-only methods to the shell, denial of app storage to the provisioner, and repeated authorization enforcement inside the elevated worker.
- Exercising app-scoped storage set/get/list/delete behavior, safe key validation, and application isolation in simulation.
- Exercising Windows account provisioning in simulation: new accounts remain disabled while credentials are returned, `users.activate` is a separate request, and existing accounts retain their passwords.
- Injecting failures after account creation, profile creation, shell assignment, and durable state writes; simulating crashes before SID return, while activation is pending, during activation, and after Windows enables the account; and verifying exact-SID rollback, fail-closed recovery, retryable activation, and shell restoration.
- Verifying the two-request existing-account password reset: `users.resetPassword` returns a generated credential without mutating the operating-system password, and only a later privileged `users.applyPassword` applies that saved value. The RPC and command-hardening tests also verify the phase boundary and that Windows passwords travel on protected standard input rather than in a command line or generated script.
- Verifying release schema 2 fixtures for Windows and Linux with exact file inventories, byte sizes, and SHA-256 hashes; changed assets, extra files, and unsafe paths fail closed.
- Verifying the complete installed-tree inventory independently, including same-size SHA-256 tampering, unexpected files, obsolete integrity metadata, and traversal entries.
- Verifying runtime navigation isolation, generated default-deny Content Security Policy, exact inline-script hashes, and Permissions Policy. The built-in shell retains microphone-only access for its trusted origin while the provisioner denies microphone access.
- Verifying trusted absolute command resolution, a sanitized subprocess environment, and protected standard-input handling for Windows temporary passwords.
- Building isolated BOSS and PreCrisis targets, checking URL relocation and every local dependency, injecting per-target CSP/Permissions Policy, recording navigation allowlists, confirming deterministic exact inventories with no symbolic links, and rejecting unsafe paths, privileged capabilities, and unknown apps.
- Enforcing the BOSS publication boundary: the 0.8.2 package contains an `empty-unpublished` zero-record catalog and no Markdown corpus; records cannot cross the package boundary without separate publication authorization.
- Running the development-only HTTP fallback and an end-to-end `system.ping` request while keeping stdout protocol-only and diagnostics on stderr.

The declared runtime requirements are administrator-managed: Node.js and Ollama are optional, and every requirement has `installable: false`. Although legacy installer helpers remain in the adapters, the API policy rejects an unavailable requirement before any installer or download dispatch. Portable checks perform no runtime downloads or third-party installation.

The portable checks intentionally do not change a real user, assign a real login shell, lock or log out the active session, approve a real elevation prompt, or launch a native target executable.

Target-only or manual verification remains necessary for:

- Displaying and approving an actual Windows UAC prompt through the kernel-PID-guarded broker. Automatic Linux PolicyKit/sudo brokerage is intentionally unavailable in 0.8.2.
- On Windows, creating a fresh disposable test account, saving its temporary credential while it is disabled, explicitly activating it, signing into its Arcane shell, exercising the separate prepare/apply password-reset flow, and restoring its previous shell through the provisioner.
- Confirming microphone capture with the operating system's real privacy controls and audio hardware.
- Compiling and launching the GTK 4/WebKitGTK 6.0 hosts on a Linux system with those development packages already installed, including confirming the clear fail-closed diagnostic for privileged requests. Real Linux account/shell provisioning and automatic administrator brokering remain disabled in 0.8.2.
- Installing missing WebView2/WebKitGTK or optional Ollama prerequisites manually from trusted operating-system or vendor channels and confirming that **Check again** recognizes them.
- Running `npm run build:apps:windows` after the Windows release build and launching each generated `ArcaneApp-<id>.exe` with its packaged WebView2, Core, and pipe-guard dependencies.
- Producing Authenticode-signed and timestamped production executables, including every distributed `ArcanePipeGuard.exe`, then confirming the runtime accepts the matching Core/guard signer. The repository's unsigned artifacts are controlled local builds only and privileged testing requires the explicit `--allow-unsigned-local-release` manifest-bound override; a distribution build must set `ARCANE_SIGNING_CERT_THUMBPRINT`, `ARCANE_TIMESTAMP_SERVER`, and `ARCANE_REQUIRE_SIGNED_RELEASE=1`.
- Confirming that signed production build and verification also require the independently configured `ARCANE_EXPECTED_PUBLISHER_THUMBPRINT` trust anchor and reject a signing certificate that does not exactly match it.
