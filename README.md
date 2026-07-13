# Arcane OS

Arcane OS contains a shared application interface runtime and native-capable Arcane applications including BOSS Libraries, PreCrisis, Redress, and Arcane Terminal. Their HTML, CSS, and JavaScript interfaces are one advantage of the architecture—not the boundary of what the applications can do. Serve the repository root for local development so applications can load the shared files under `arcane/`.

## Run locally

Install the pinned JavaScript dependency used by the browser modules:

```powershell
npm ci
```

From the repository root, start any static HTTP server. For example:

```powershell
python -m http.server 8000
```

Then open:

- PreCrisis: <http://localhost:8000/apps/precrisis/index.html>
- BOSS: <http://localhost:8000/apps/boss/chat.html>
- Redress: <http://localhost:8000/apps/redress/index.html>
- Arcane Terminal: <http://localhost:8000/apps/terminal/index.html>
- Files: <http://localhost:8000/apps/files/index.html>
- Settings: <http://localhost:8000/apps/settings/index.html>
- Arcane Mail: <http://localhost:8000/apps/mail/index.html>
- Arcane Messages: <http://localhost:8000/apps/messages/index.html>
- Shared chart example: <http://localhost:8000/example/component_chart/index.html>
- Parent-configured dashboard example: <http://localhost:8000/example/component_dashboard_config/index.html>
- Markdown editor example: <http://localhost:8000/example/component_markdown_editor/index.html>
- Voice transcription example: <http://localhost:8000/example/component_voice_transcription/index.html>
- Theme switcher and custom-skin example: <http://localhost:8000/example/component_theme/index.html>
- Unified communications example: <http://localhost:8000/example/component_communications/index.html>

Do not serve an individual application directory by itself. The applications intentionally load shared modules, entities, components, styles, and assets from the repository-level `arcane/` directory.

## Repository layout

- `arcane/` contains reusable browser modules, entities, components, styles, and assets.
- `apps/precrisis/` contains the PreCrisis pages and its domain-specific code and assets.
- `apps/boss/` contains the BOSS pages, components, styles, and assets.
- `apps/redress/` contains the Redress Legal Workbench.
- `apps/terminal/` contains Arcane Terminal's app-specific command catalog, registered system tools, and composition layer.
- `apps/files/`, `apps/settings/`, `apps/mail/`, and `apps/messages/` contain essential user utilities, composed from shared Arcane components and modules.
- `example/` contains small pages and usage notes for the shared runtime and app-specific extensions.
- `test/` contains Node-based tests for browser-independent runtime behavior.
- `Ideation/` contains product, architecture, and design exploration rather than production runtime code.

Before creating or materially changing an app, component, module, entity, or other runtime capability, follow the mandatory [`Arcane app-building Standard Operating Procedure`](./docs/app-building.md). It defines the shared-core/app-specific boundary required for both human and AI contributors.

When diagnosing or fixing unexpected behavior, follow the mandatory [`ASS-U-ME No-Assumptions Debugging Standard Operating Procedure`](./docs/debugging.md). Verify the expectation first, then work one proven step at a time: reproduce, preserve, inspect, isolate, manually fix and verify, fix the code, rebuild, and retest from a clean state.

## Reusable components

Reusable components under `arcane/components/` include charts, dashboard configuration, Markdown editing, voice transcription, the provider-backed file manager, unified communication inboxes, conversation views, integration settings, terminal workspaces, assistant panels, application bars, one-click theme switching, safe custom-skin editing, native-dialog modals, file drop, task progress, summary strips, file inspection, and output panels. Neutral tokens and interface primitives live in `arcane/css/primitives.css`. Parent apps supply their domain data, labels, routes, persistence, and actions through properties, `configure(...)`, slots, and component events.

New applications follow the reuse-first review gate in [`docs/app-building.md`](./docs/app-building.md): name the behavior, decide whether other apps can use it, isolate app-specific business rules, and expose the reusable core through configuration or injected adapters.

Arcane Settings provides the operating-system AI provider choice. Ollama uses the global ArcaneOllama service and protected machine-wide model store; users can pull models, create a named Arcane brain from any Ollama base, select a default model, preload it at boot, and tune bounded context/service settings. OpenAI is also available: the user selects an account-accessible model and saves an API token through Arcane Core's protected per-user credential store. Applications use the capability-gated Arcane AI APIs and never receive the saved token. Communications credentials remain in their provider authorization flow, native credential service, or local Arcane communications bridge.

## Test

```powershell
npm run check
```

`npm run check` runs the shared/root tests, the Redress suites, the BOSS public-release policy test, exact validation of every configured public package in `dist/`, and the portable machine-bundle verification gate. Use `npm test` for the faster shared/root suite only. The pre-push hook then runs the compiled Microsoft NT native gate separately, so public-package validation does not duplicate the longer native-host build.

This repository does not provide a hosted backend service or installer. Features that call mail, artificial intelligence, speech, or other services require separately provided endpoints.

## Package public applications

Arcane OS includes a public-app packager with a reusable Node library, a command-line interface, and npm routes. It discovers immediate directories under `apps/`, reads each app's authoritative semantic version from `arcane-package.json`, and creates an isolated website root at `dist/<app>`.

```powershell
npm run apps:list
npm run app:inspect -- boss
npm run app:package -- boss --dry-run
npm run app:package -- boss
npm run app:check -- boss
npm run check:public-apps
```

Use `app:package` for a reproducible build at the current version. Use `app:release` to build, verify, and patch-bump atomically, or select another semantic-version level explicitly:

```powershell
npm run app:release -- boss
npm run app:release -- precrisis --bump minor
npm run app:bump -- redress 1.0.0
```

The root [`arcane-packager.json`](./arcane-packager.json) defines named shared payloads. Each `apps/<app>/arcane-package.json` defines the app ID, version, entry point, positive include list, defensive exclude list, shared payloads, and packaging strategy. Excludes are literal app-relative paths; excluding a directory excludes all descendants. The packager rejects traversal, links and junctions, repository metadata, environment files, destination collisions, and output outside `dist/`.

Every package preserves the repository-shaped paths expected by Arcane application interfaces, writes a deterministic `ARCANE_APP_RELEASE.json` file inventory with SHA-256 hashes, verifies the staged result, and atomically replaces only `dist/<app>`. See [`docs/app-packaging.md`](./docs/app-packaging.md) for the full command and configuration reference.

## BOSS public website package

Never deploy or publicly serve this working repository: ignored BOSS source material is still reachable from a repository-root static server. Build and verify the isolated BOSS website root instead:

```powershell
npm run build:boss-public
npm run check:boss-public
python -m http.server 8000 --directory dist/boss
```

Publish only `dist/boss/`. The package contains the approved public library and its public originals; user uploads remain in Database Origin Private File System (DBOPFS) browser storage and are not part of the website files.
