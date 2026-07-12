# Arcane OS

Arcane OS currently contains a shared browser runtime and two browser applications: PreCrisis and BOSS. Serve the repository root so both applications can load the shared files under `arcane/`.

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
- Shared chart example: <http://localhost:8000/example/component_chart/index.html>
- Parent-configured dashboard example: <http://localhost:8000/example/component_dashboard_config/index.html>
- Markdown editor example: <http://localhost:8000/example/component_markdown_editor/index.html>
- Voice transcription example: <http://localhost:8000/example/component_voice_transcription/index.html>

Do not serve an individual application directory by itself. The applications intentionally load shared modules, entities, components, styles, and assets from the repository-level `arcane/` directory.

## Repository layout

- `arcane/` contains reusable browser modules, entities, components, styles, and assets.
- `apps/precrisis/` contains the PreCrisis pages and its domain-specific code and assets.
- `apps/boss/` contains the BOSS pages, components, styles, and assets.
- `example/` contains small pages and usage notes for the shared runtime and app-specific extensions.
- `test/` contains Node-based tests for browser-independent runtime behavior.
- `Ideation/` contains product, architecture, and design exploration rather than production runtime code.

## Reusable components

The chart, dashboard-configuration shell, Markdown editor, and voice-transcription control live under `arcane/components/`. They contain no PreCrisis chart names or dashboard persistence rules. The parent page supplies chart definitions, labels, data, visibility, and save behavior through component properties, `configure(...)`, and component events. PreCrisis remains one consumer of those APIs; the pages under `example/` show neutral, standalone uses.

Arcane OS does not select a hosted artificial-intelligence provider or commit service credentials. A parent application must configure its provider at runtime (or let a user supply their own key). Mail transport likewise requires runtime `globalThis.arcane.config.mail` values. Keep keys and private endpoints outside tracked files.

## Test

```powershell
npm test
```

This repository does not yet provide a supported backend service, command-line interface, installer, or production deployment wrapper. Features that call mail, artificial intelligence, speech, or other services require separately provided endpoints.
