# Arcane API Reference

`window.Arcane` is the immutable application-facing API provided by the Arcane native host bridge. Arcane applications use the same contract when hosted by WebView2 on Microsoft NT, WebKitGTK on Linux, the Android WebView launcher bridge, or the development HTTP bridge. This is not a browser-only API: calls cross into the native Arcane runtime or platform service, and the available native operation is governed by the application's declared capabilities and host policy.

The Android bridge is an experimental foundation. Its source controller binds one WebView to one immutable packaged entry at the exact reserved HTTPS origin and denies non-packaged navigation and resources. A generated Android application registry derives the bundle version plus Shell identity, entry, and grant intersection from the canonical bundle manifest and method policy registry. One immutable host session has no caller-supplied identity, entry, or grant inputs; it requires the installed launcher package version to equal the generated bundle version and snapshots minimized platform facts without exposing WebView patch version. The controller consumes that same session entry. AndroidX WebKit injects the bridge only at that origin, and the bridge admits messages only from the main frame after checking source origin, method admission, grant where required, and replay state. The controller can be installed only once and exposes a UI-thread teardown result that distinguishes removal of native bridge authority from full WebView destruction; failed destruction remains retryable, and authority-revoked controllers cannot load or install again. This teardown does not erase the shared WebView profile, cookies, DOM storage, cache, or service-worker data. The canonical Shell receives capability-free, bound-session `system.ping`, `version.current`, and `app.current` plus `platform.status` and `network.status`. Ping returns only `{ok:true}` and does not claim health, readiness, privilege, or trust. Version and application identity are provider-free reads of the immutable session; Android application trust remains `unverified` with no publisher or revocation claim. Android network status preserves the Core meaning of `{ online, interfaceCount }` by counting interfaces with non-loopback addresses, returns no interface identity or address, bounds malformed provider results, and requires no Android permission. The reviewed mailto-only `external.open` host implementation remains unavailable to the Shell because its canonical manifest does not grant that capability. Every other method and URI scheme fails closed. Generated source authority and package-version equality are not APK-signer or runtime-session authentication. Kotlin compilation/runtime behavior is not yet proven, and this does not establish a complete Android launcher, authenticated package/session policy, signed application catalog, persistent-profile retention/deletion policy, scoped-storage resource grant, process recovery, update, or release contract.

The current debug-local-test Android distribution supersedes the earlier source-only status above: Kotlin compilation and API 35 instrumentation now pass for a HOME-eligible Shell plus 17 separately installed application APKs. Each app binds one verified packaged entry, Android identity, UID, storage scope, declared grants, and registry-derived network policy. `Arcane.applications.launch(id)` resolves only an installed generated package. Arcane Terminal alone receives the Android terminal provider, which runs bounded `/system/bin/sh` sessions under its ordinary app UID and private default working directory. This remains unsigned local evidence, not signer authentication, production release approval, update/recovery acceptance, or accessibility conformance.

Every operation returns a `Promise` unless the return column says otherwise. Rejected operations use `Arcane.Error`, which exposes `code`, `message`, `resolution`, `diagnosticId`, and technical diagnostic fields when available.

Parameter objects shown as optional may be omitted. Actual availability is also controlled by the application's declared capabilities and native policy.

Android host installation reports whether cleanup remains required and includes the teardown result after a partial setup failure. A launcher must retain that controller and retry close rather than treating every failed installation as clean.

## Core and events

| Method / property | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.protocol` | None | `"arcane/1"` | Native bridge protocol identifier. |
| `Arcane.Error` | Error value | `ArcaneError` constructor | Normalized native/API error type. |
| `Arcane.events.on(eventName, listener)` | Event name; callback | `unsubscribe()` | Subscribes to a native event or `*` for all events. |
| `Arcane.events.once(eventName, listener)` | Event name; callback | `unsubscribe()` | Subscribes for the next matching event only. |
| `Arcane.events.when(eventName, listener)` | Designated completion event; callback | `unsubscribe()` | Subscribes to a durable lifecycle completion. A late subscriber receives the first stored completion asynchronously. |
| `Arcane.events.completed(eventName)` | Designated completion event | `boolean` | Reports whether this document has observed that completion. |

`transport.ready` and `core.ready` are the initial durable completions. Their
first JSON payload is snapshotted and frozen before live callbacks run; repeated
completions do not replace it. Ordinary events and `once()` remain future-only,
so progress, stream, and appearance updates are never replayed as stale state.
`transport.ready` means that this document selected a callable Arcane messaging
surface. It does not prove host health, application authority, capability grants,
publisher trust, or release readiness.

## Artificial intelligence and Ollama

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.ai.models()` | None | `Promise<model[]>` | Lists models for the active AI provider. |
| `Arcane.ai.chat(request)` | Provider-neutral chat request | `Promise<chat result>` | Sends a chat request through the configured provider. |
| `Arcane.ai.profile()` | None | `Promise<profile>` | Gets the effective AI profile. |
| `Arcane.ai.providerSettings()` | None | `Promise<settings>` | Gets provider selection and settings. |
| `Arcane.ai.saveProviderSettings(settings)` | Settings object | `Promise<settings/result>` | Validates and saves provider settings. |
| `Arcane.ai.providerModels()` | None | `Promise<model[]>` | Queries models from the configured provider. |
| `Arcane.ollama.version()` | None | `Promise<version record>` | Gets the managed Ollama version. |
| `Arcane.ollama.models()` | None | `Promise<model[]>` | Lists installed Ollama models. |
| `Arcane.ollama.list()` | None | `Promise<model[]>` | Alias of `models()`. |
| `Arcane.ollama.running()` | None | `Promise<model[]>` | Lists running/loaded models. |
| `Arcane.ollama.show(model, options?)` | Model name; optional show fields | `Promise<model details>` | Gets model metadata and configuration. |
| `Arcane.ollama.generate(request, options?)` | Generate request; `{onChunk?, timeoutMs?}` or callback | `Promise<generate result>` | Generates text; optionally reports `ollama.chunk` stream data. |
| `Arcane.ollama.chat(request, options?)` | Chat request; stream options | `Promise<chat result>` | Runs native Ollama chat, optionally streamed. |
| `Arcane.ollama.embed(request)` | Embed request | `Promise<embedding result>` | Creates embeddings. |
| `Arcane.ollama.pull(model, options?, streamOptions?)` | Model; pull options; stream options | `Promise<pull result>` | Pulls a model with a long-operation timeout. |
| `Arcane.ollama.push(model, options?, streamOptions?)` | Model; push options; stream options | `Promise<push result>` | Pushes a model to its configured registry. |
| `Arcane.ollama.create(request, options?)` | Create request; stream options | `Promise<create result>` | Creates a model from a Modelfile definition. |
| `Arcane.ollama.copy(source, destination)` | Source and destination model names | `Promise<result>` | Copies/renames a model. |
| `Arcane.ollama.delete(model)` | Model name | `Promise<result>` | Deletes a model. |
| `Arcane.ollama.selection()` | None | `Promise<selection>` | Gets Arcane's Ollama model preference. |
| `Arcane.ollama.select(preference)` | Model name or `auto` | `Promise<selection>` | Sets the preferred model. |
| `Arcane.ollama.settings()` | None | `Promise<settings>` | Gets Ollama runtime settings. |
| `Arcane.ollama.saveSettings(settings)` | Runtime settings | `Promise<settings/result>` | Saves Ollama runtime settings. |
| `Arcane.ollama.createBrain(definition)` | Brain/model definition | `Promise<model result>` | Creates an Arcane brain model. |
| `Arcane.ollama.serviceSettings()` | None | `Promise<settings>` | Gets managed Ollama service settings. |
| `Arcane.ollama.saveServiceSettings(settings)` | Service settings | `Promise<settings/result>` | Saves managed service settings. |

## Applications, terminal, and capabilities

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.app.current()` | None | `Promise<app record>` | Gets the exact bound application descriptor. Android returns immutable generated Shell identity with `unverified` publisher status. |
| `Arcane.applications.list()` | None | `Promise<app[]>` | Lists applications visible to the current host/app. |
| `Arcane.applications.launch(id)` | Application ID | `Promise<launch result>` | Launches a registered application. |
| `Arcane.external.open(uri)` | Exact printable-ASCII URI without whitespace, fragments, backslashes, malformed escapes, or encoded controls; currently `mailto:` only | `Promise<{opened, uri}>` | Hands a validated URI to the operating system's registered default application. `opened: true` means only that the OS accepted the handoff, not that a composer opened or a message was sent. Simulation fails explicitly instead of claiming a handoff. Requires `external.open`. |
| `Arcane.terminal.start(options?)` | `{shell="auto", cwd="", columns=120, rows=32}` | `Promise<session>` | Starts a native terminal session. |
| `Arcane.terminal.list()` | None | `Promise<session[]>` | Lists terminal sessions owned by the app. |
| `Arcane.terminal.write(sessionId, data)` | Session ID; input text | `Promise<result>` | Writes data to a session. |
| `Arcane.terminal.resize(sessionId, columns, rows)` | Session ID; numeric dimensions | `Promise<result>` | Resizes a terminal session. |
| `Arcane.terminal.signal(sessionId, signal="interrupt")` | Session ID; signal | `Promise<result>` | Sends a supported control signal. |
| `Arcane.terminal.close(sessionId)` | Session ID | `Promise<result>` | Closes a terminal session. |
| `Arcane.capabilities.list()` | None | `Promise<{ app, grants, methods }>` | Returns the current application descriptor, its granted capabilities, and its exact allowed RPC methods. |

## Platform, installation, users, and system

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.platform.status()` | None | `Promise<status>` | Gets native platform status. |
| `Arcane.permissions.status()` | None | `Promise<status>` | Gets permission/elevation status. |
| `Arcane.version.current()` | None | `Promise<string>` | Gets the version identifier of the active packaged ARCANE payload bound to this host session. It is not signer, update, or RC attestation. |
| `Arcane.version.installation()` | None | `Promise<installation status>` | Alias-like access to installation status. |
| `Arcane.machine.status()` | None | `Promise<status>` | Gets machine readiness/status. |
| `Arcane.user.current()` | `identity.read` | `Promise<identity>` | Gets the privacy-minimized bound identity. Microsoft NT/Linux return a `host-account`; Android returns an anonymous `local-session` with null account identifiers. |
| `Arcane.requirements.list()` | None | `Promise<requirement[]>` | Lists installation requirements. |
| `Arcane.requirements.ensure(requirementIds)` | Array of requirement IDs, or omitted for all | `Promise<result>` | Ensures selected requirements are installed/configured. |
| `Arcane.installation.status()` | None | `Promise<status>` | Gets installation state. |
| `Arcane.installation.ensure()` | None | `Promise<result>` | Ensures the Arcane installation reaches its required state. |
| `Arcane.users.list()` | None | `Promise<user[]>` | Lists supported local users. |
| `Arcane.users.validate(usernames)` | Username or array | `Promise<validation result>` | Validates candidate usernames. |
| `Arcane.users.add(usernames)` | Username or array | `Promise<result>` | Creates/configures local Arcane users. |
| `Arcane.users.activate(username)` | Username | `Promise<result>` | Activates a configured user. |
| `Arcane.users.resetPassword(username)` | Username | `Promise<temporary-password result>` | Begins a password reset. |
| `Arcane.users.applyPassword(username, temporaryPassword)` | Username; temporary password | `Promise<result>` | Applies the temporary password through the native workflow. |
| `Arcane.users.verifyShell(username)` | Username | `Promise<verification>` | Verifies the user's Arcane shell configuration. |
| `Arcane.users.restoreShell(username)` | Username | `Promise<result>` | Restores the supported shell configuration. |
| `Arcane.system.lock()` | None | `Promise<result>` | Locks the operating-system session. |
| `Arcane.system.ping()` | None | `Promise<{ok:true}>` | Confirms only that the bound host bridge admitted and answered the request. It does not claim dependency readiness, system health, privilege, signer trust, or release-candidate status. |
| `Arcane.system.metrics()` | None | `Promise<metrics>` | Gets allowed machine metrics. |
| `Arcane.network.status()` | None | `Promise<{online, interfaceCount}>` | Counts interfaces with at least one non-loopback address. `online` does not claim Internet, DNS, captive-portal, route, or service reachability. |

Core-backed `platform.status` and `machine.status` records include `execution.hostPlatform`, `execution.effectivePlatform`, `execution.simulation`, and `execution.evidenceClass`. The Android bridge returns the same execution fields with `application-host` evidence. A simulated effective platform is test evidence only; no simulation or source-only Android assertion is real-host, publisher, signing, or release-candidate evidence.

The native desktop contract retains the technical compatibility values `platform: "windows"` and `rawPlatform: "win32"`; user-facing interfaces present that family as **Microsoft NT**. `arcane/modules/SystemPlatformPresentation.js` maps the verified status to `Microsoft NT` or `Linux` and applies `arcane-kernel-nt` or `arcane-kernel-linux`, plus `data-arcane-kernel`, to the document root. Those DOM values exist only for presentation and CSS. They must never grant a capability, establish release trust, select a native adapter, or substitute for `Arcane.permissions.status()` and host-verified execution evidence.

The canonical semantic definitions for the fifteen currently shared Core/Android methods live in `machine_bundles/arcane-os-machine-bundle-v0.8.4/src/api/method-contracts.json`. They are deliberately separate from method authority policy: semantic effect metadata cannot grant a capability, admit an application or host, or imply privilege. Core executes the closed input/output validators at its request and response boundaries. Android consumes separately generated semantic constants and validates or constructs the corresponding results; the exact unsigned-debug distribution now has Kotlin build parity and API 35 Launcher, Browser, and Terminal instrumentation evidence. The registry remains a partial vertical slice: privacy-safe audit and confirmation infrastructure, definitions for the remaining 61 Core-only methods, production signing, real-device conformance, and candidate review are still required.

## Filesystem, storage, preferences, and appearance

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.filesystem.selectDirectory(options?)` | Directory picker options object | `Promise<selection>` | Opens the native directory picker; rejects non-object options. |
| `Arcane.storage.list()` | None | `Promise<entry[]>` | Lists app-scoped native storage entries. |
| `Arcane.storage.get(key)` | Key | `Promise<value/result>` | Reads an app-scoped value. |
| `Arcane.storage.set(key, value)` | Key; JSON-compatible value | `Promise<result>` | Writes an app-scoped value. |
| `Arcane.storage.delete(key)` | Key | `Promise<result>` | Deletes an app-scoped value. |
| `Arcane.preferences.list()` | None | `Promise<entry[]>` | Lists app-scoped preferences. |
| `Arcane.preferences.get(key)` | Key | `Promise<value/result>` | Reads a preference. |
| `Arcane.preferences.set(key, value)` | Key; JSON-compatible value | `Promise<result>` | Writes a preference. |
| `Arcane.preferences.delete(key)` | Key | `Promise<result>` | Deletes a preference. |
| `Arcane.appearance.current()` | None | `Promise<appearance>` | Gets current native appearance state. |
| `Arcane.appearance.apply(appearance)` | Appearance contract | `Promise<appearance/result>` | Applies allowed native appearance values. |

Native storage and preferences resolve below
`<state-root>/Arcane OS/apps/<application-id>/` as `storage.json` and
`preferences.json`. The host-bound canonical app ID selects the folder; callers
cannot provide a different identity. Browser OPFS follows
`apps/<application-id>/...`, DBLS fallback keys use
`arcane.apps.<application-id>:`, and native browser profiles are also app-owned.
Unowned legacy global data is preserved but not guessed into an app. See
[Application data isolation](application-data-isolation.md) for the complete
layout and same-origin browser limitation.

## Session, provisioning, diagnostics, and development

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.session.logout()` | None | `Promise<result>` | Requests logout of the current host operating-system session. This is not an Arcane-only application exit. |
| `Arcane.provisioning.plan(usernames)` | Username or array | `Promise<plan>` | Creates a provisioning plan without applying it. |
| `Arcane.diagnostics.recentErrors()` | None | `Promise<diagnostic[]>` | Lists recent structured errors. |
| `Arcane.diagnostics.get(diagnosticId)` | Diagnostic ID | `Promise<diagnostic>` | Gets one diagnostic record. |
| `Arcane.development.inspect(root)` | Checkout root path | `Promise<inspection>` | Inspects an approved development workspace. |
| `Arcane.development.context(root, query)` | Checkout root; bounded query | `Promise<context>` | Gets bounded source context for developer assistance. |
| `Arcane.development.setup(root, taskId)` | Checkout root; registered setup task ID | `Promise<result>` | Runs an allowlisted development setup task. |
| `Arcane.development.installNode()` | None | `Promise<result>` | Installs the supported Node.js development runtime. |

## Maintenance rule

The source of truth for the application-facing native bridge API is `machine_bundles/arcane-os-machine-bundle-v0.8.4/src/frontend/shared/arcane-api.js`. Follow [Developer Reference Maintenance SOP](developer-reference-sop.md): every added, renamed, or changed `Arcane` method must update this table's parameters, return, and description in the same change.
