# Arcane API Reference

`window.Arcane` is the immutable application-facing API provided by the Arcane native host bridge. Arcane applications use the same contract when hosted by WebView2 on Microsoft NT, WebKitGTK on Linux, or the development HTTP bridge. This is not a browser-only API: calls cross into the native Arcane runtime, and the available native operation is governed by the application's declared capabilities and host policy.

Every operation returns a `Promise` unless the return column says otherwise. Rejected operations use `Arcane.Error`, which exposes `code`, `message`, `resolution`, `diagnosticId`, and technical diagnostic fields when available.

Parameter objects shown as optional may be omitted. Actual availability is also controlled by the application's declared capabilities and native policy.

## Core and events

| Method / property | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.protocol` | None | `"arcane/1"` | Native bridge protocol identifier. |
| `Arcane.Error` | Error value | `ArcaneError` constructor | Normalized native/API error type. |
| `Arcane.events.on(eventName, listener)` | Event name; callback | `unsubscribe()` | Subscribes to a native event or `*` for all events. |
| `Arcane.events.once(eventName, listener)` | Event name; callback | `unsubscribe()` | Subscribes for the next matching event only. |

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
| `Arcane.app.current()` | None | `Promise<app record>` | Gets the current application's identity and context. |
| `Arcane.applications.list()` | None | `Promise<app[]>` | Lists applications visible to the current host/app. |
| `Arcane.applications.launch(id)` | Application ID | `Promise<launch result>` | Launches a registered application. |
| `Arcane.external.open(uri)` | Absolute URI; currently `mailto:` only | `Promise<{opened, uri}>` | Hands a validated URI to the operating system's registered default application. Requires `external.open`. |
| `Arcane.terminal.start(options?)` | `{shell="auto", cwd="", columns=120, rows=32}` | `Promise<session>` | Starts a native terminal session. |
| `Arcane.terminal.list()` | None | `Promise<session[]>` | Lists terminal sessions owned by the app. |
| `Arcane.terminal.write(sessionId, data)` | Session ID; input text | `Promise<result>` | Writes data to a session. |
| `Arcane.terminal.resize(sessionId, columns, rows)` | Session ID; numeric dimensions | `Promise<result>` | Resizes a terminal session. |
| `Arcane.terminal.signal(sessionId, signal="interrupt")` | Session ID; signal | `Promise<result>` | Sends a supported control signal. |
| `Arcane.terminal.close(sessionId)` | Session ID | `Promise<result>` | Closes a terminal session. |
| `Arcane.capabilities.list()` | None | `Promise<capability[]>` | Lists the current application's allowed capabilities. |

## Platform, installation, users, and system

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.platform.status()` | None | `Promise<status>` | Gets native platform status. |
| `Arcane.permissions.status()` | None | `Promise<status>` | Gets permission/elevation status. |
| `Arcane.version.current()` | None | `Promise<version>` | Gets the current Arcane bundle version. |
| `Arcane.version.installation()` | None | `Promise<installation status>` | Alias-like access to installation status. |
| `Arcane.machine.status()` | None | `Promise<status>` | Gets machine readiness/status. |
| `Arcane.user.current()` | None | `Promise<user>` | Gets the active Arcane/operating-system user context. |
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
| `Arcane.system.ping()` | None | `Promise<pong/status>` | Performs a short-timeout native liveness check. |
| `Arcane.system.metrics()` | None | `Promise<metrics>` | Gets allowed machine metrics. |
| `Arcane.network.status()` | None | `Promise<status>` | Gets network status. |

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

## Session, provisioning, diagnostics, and development

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.session.logout()` | None | `Promise<result>` | Logs out of the Arcane session. |
| `Arcane.provisioning.plan(usernames)` | Username or array | `Promise<plan>` | Creates a provisioning plan without applying it. |
| `Arcane.diagnostics.recentErrors()` | None | `Promise<diagnostic[]>` | Lists recent structured errors. |
| `Arcane.diagnostics.get(diagnosticId)` | Diagnostic ID | `Promise<diagnostic>` | Gets one diagnostic record. |
| `Arcane.development.inspect(root)` | Checkout root path | `Promise<inspection>` | Inspects an approved development workspace. |
| `Arcane.development.context(root, query)` | Checkout root; bounded query | `Promise<context>` | Gets bounded source context for developer assistance. |
| `Arcane.development.setup(root, taskId)` | Checkout root; registered setup task ID | `Promise<result>` | Runs an allowlisted development setup task. |
| `Arcane.development.installNode()` | None | `Promise<result>` | Installs the supported Node.js development runtime. |

## Maintenance rule

The source of truth for the application-facing native bridge API is `machine_bundles/arcane-os-machine-bundle-v0.8.4/src/frontend/shared/arcane-api.js`. Follow [Developer Reference Maintenance SOP](developer-reference-sop.md): every added, renamed, or changed `Arcane` method must update this table's parameters, return, and description in the same change.
