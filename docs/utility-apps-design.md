# Arcane utility applications capability design

### Arcane capability decision

- I need to make a: set of user utilities for web navigation, YouTube playback, YouTube Music playback, Markdown editing, calculation, screen/image/video/GIF capture, and weather display; plus a reusable event-driven model database that fetches and parses API data.
- Could other applications use it: yes. Navigation surfaces, media URL parsing, expression evaluation, capture, API fetching/caching, weather records, and compact weather display are all useful outside the app that introduces them.
- App-specific business logic: app names and wording; Browser home URL; YouTube versus YouTube Music destination/search behavior; Markdown draft persistence and export filename; Capture download names; Weather provider endpoint choices and location search orchestration.
- Reusable core: `ApiModelDatabase`, API response records, calculation records and engine, media locator/parser, screen capture/GIF encoder, weather records/provider/widget, web navigator, media embed, calculator, and capture controls.
- Extraction boundary: configuration and `CustomEvent` contracts for components; injected fetch/parser/cache providers for API data; record mapping for weather; app modules for persistence, download, and provider policy.
- Arcane theme base: every app loads `arcane/css/theme.css` and `arcane/modules/ThemeBootstrap.js`; components consume Arcane variables and shared primitives.
- CSS layer order: optional layout -> Arcane theme -> primitives -> shared utility workspace -> app CSS -> component-local narrow styles.
- User-theme verification: system, explicit light, explicit dark, and custom-token inheritance are covered by source contracts and browser smoke checks.
- Shared files: new reusable entities/modules/components under `arcane/`; one consolidated synthetic utility-suite example.
- App files: thin compositions under `apps/browser`, `apps/youtube`, `apps/youtube-music`, `apps/markdown`, `apps/calculator`, `apps/capture`, and `apps/weather`.
- Contract and compatibility impact: additive. Existing Markdown editor behavior is reused unchanged. The portable app wrapper gains explicit `web.embed` and `media.display` capabilities and an optional `frameOrigins` security list; existing apps retain their current policy.
- Verification: focused entity/module/component tests, machine capability tests, synthetic examples, public packaging, portable packaging, full root tests, and local browser checks.

## Public contracts

### API model database

`ApiModelDatabase` extends `EventTarget`. The constructor accepts an endpoint, parser, optional fetch implementation, request defaults, and optional cache adapter. `fetch(parameters, context)` returns an immutable `ApiModelRecord` and emits `api-model-request`, `api-model-success`, or `api-model-error`. Parsed content is returned as `record.value`. Secrets are never persisted or included in events. HTTP and parser failures reject and remain observable.

### Web and media navigation

The web navigator accepts a parent-provided home URL and emits `web-navigate` and `web-open-external`. It uses a sandboxed frame and visibly explains that sites may refuse embedding. The media embed accepts a normalized YouTube video or playlist locator and never accepts arbitrary embed HTML.

### Calculation

The calculator engine accepts a bounded mathematical expression, parses it without `eval` or `Function`, returns a `Calculation` record, and emits success/error events. The component owns keypad interaction but not history persistence.

### Capture

`ScreenCapture` requests display permission only in direct response to the user's action. It returns PNG, browser-supported video, or standards-compliant GIF blobs and emits state/result/error events. The component never uploads captures. The parent decides whether and where to download or store them.

### Weather

Weather location, current observation, daily forecast, and snapshot entities are provider-neutral. `OpenMeteoWeatherProvider` maps the configured geocoding and forecast endpoints into those records through `ApiModelDatabase`. `weather-widget.html` renders supplied records and emits refresh/location events; it performs no network or persistence work, making it suitable for the shell.

## Machine policy

- `media.display` enables `display-capture=(self)` only for apps that request it.
- `web.embed` enables `frame-src` only for the app's declared `security.frameOrigins`.
- Exact HTTPS frame origins remain the default. The special `https:` scheme source is accepted only for the general Browser app with `web.embed`, and its component frame remains sandboxed without same-origin access.
