# Redress to Arcane Component Plan

Redress should reuse Arcane for domain-neutral interface structure and keep legal rules inside the app. New shared work should use native HTML, CSS, JavaScript, browser APIs, repository-owned Arcane modules, and appropriate vanilla modules authored by RIAEvangelist. Do not add unrelated third-party libraries, remote assets, content-delivery networks, or external code references.

All app and component URLs remain repository-relative. Redress keeps the established `<base href="../../">` convention, so app links use `./apps/redress/...` and shared links use `./arcane/...`.

## Priority component boundaries

### 1. Extend the Arcane file manager

Extend `arcane/components/file-manager.html`; do not create a second permanent case-tree component.

The existing manager understands flat DBOPFS tables and owns file opening, upload, deletion, and modal behavior. Redress already has nested logical paths even though its blobs are stored in flat DBOPFS tables. The shared manager should gain a backward-compatible `data-layout="tree"` option and a provider adapter.

The tree provider should expose domain-neutral entries:

```js
list(path) => [{
    name,
    path,
    kind: 'directory' | 'file',
    size,
    mimeType,
    lastModified,
    status,
    hasChildren
}]
```

The component should add:

- `setProvider(provider)` without removing the existing global-DBOPFS default;
- `selectedPath` and `select(path)`;
- lazy nested directory rendering and file counts;
- `file-manager-select`, `file-manager-open`, and `file-manager-action` events;
- an event-only open mode so an app can supply its own inspector;
- proper tree keyboard behavior, roving focus, and selected-state semantics; and
- generic filtering instead of the current BOSS-specific hidden-name rule.

BOSS and PreCrisis must retain their current `data-dirs`, `data-layout="grid"`, `data-layout="files"`, `loadAll()`, and `file-manager-ready` behavior.

Redress will supply a case adapter over `caseRecord.files`. Filing/evidence classifications, paired Markdown, review rules, and rename constraints remain Redress responsibilities.

### 2. Add an Arcane assistant drawer

The responsive Redress assistant shell should become `arcane/components/assistant-panel.html`. Arcane already has `arcane/components/chat.html`, but that component also owns uploads, speech, languages, and global AI behavior, so it is not a direct replacement for the legal assistant.

The shared assistant drawer should own:

- docked and overlay layouts;
- `open()`, `close()`, and `toggle()`;
- accessible open/close state, Escape handling, and focus return;
- title, subtitle, identity, messages, composer, actions, and footer slots;
- pending, streaming, error, and empty presentation states; and
- `assistant-opened`, `assistant-closed`, `assistant-send`, and `assistant-clear` events.

Redress keeps case-context retrieval, legal prompts, provider consent, chat persistence, and work-product rules.

### 3. Add an Arcane application bar

The Redress and BOSS horizontal navigation bars use the same structure: brand, responsive route links, active state, and a trailing status/action area. Extract that shell into an Arcane app-bar component with slots or data for:

- brand mark and product name;
- navigation links;
- active-route state; and
- status and trailing actions.

Routes, labels, product identity, and colors remain app-owned. PreCrisis can keep its rail layout until it opts into a horizontal mode.

### 4. Modernized Arcane modal

Redress uses `arcane/components/modal.html` for its modal lifecycle and supplies repository-relative, component-scoped CSS for the legal forms. The shared component now implements its surface with native `<dialog>`.

Its public `populate()`, `open()`, `close()`, `runTasks()`, modal stack, and events remain intact. Header, body, footer, and close-control parts keep app styling independent of the component's private structure.

### 5. Promote shared CSS primitives

These are better as Arcane CSS primitives than one web component per element:

- action, secondary, tertiary, icon, and close buttons;
- card shell with header, body, and footer regions;
- view and section headings;
- form grid, field, help text, and form note;
- status light, pill, badge, and count;
- empty, loading, error, and review-needed states; and
- responsive spacing, surface, border, and shadow tokens.

Redress can continue to provide legal colors and typography through CSS variables.

### 6. Promote behavioral patterns

After the base primitives are stable, extract:

- a file-drop card that combines drag/drop, a native file picker, busy state, progress, and error events;
- a task-progress panel shared by import jobs and modal task runs;
- a summary/stat strip;
- a file inspector/preview surface that can be composed with the file manager; and
- an output panel with title, coverage/status, actions, and a body region.

The Redress CRAC teaching cards, case profile, legal workflow forms, filing/evidence naming, authority metadata, and substantive output copy remain app-specific.

## Dependency rule

The new tree, assistant, modal, navigation, and visual primitives must not introduce unrelated third-party packages. RIAEvangelist-authored vanilla modules are approved first-party building blocks and may be used when they improve consistency or correctness. This includes the existing `strong-type` dependency used by Arcane's DBOPFS and FileEntity paths; new provider and tree contracts may use it where runtime type validation is useful.

## Implemented component seam

The shared component pass is complete:

- `arcane/components/file-manager.html` now supplies the provider-backed tree, selection/open/action events, lazy folders, file counts, keyboard navigation, and event-only open mode. Redress supplies the adapter over `caseRecord.files` and retains legal naming, pairing, review, and inspector rules.
- `arcane/components/assistant-panel.html` owns docked/overlay layout, focus and Escape behavior, presentation state, slots, and assistant shell events. Redress retains retrieval, prompts, persistence, consent, and work-product behavior.
- `arcane/components/app-bar.html` now provides the shared Redress and BOSS navigation shell while each app retains its routes, identity, status, and palette.
- `arcane/components/modal.html` now uses native `<dialog>` and preserves the legacy lifecycle API, task runner, stack, and events. Redress form CSS uses component variables and public parts rather than overriding the modal's private structure.
- Redress handles the file manager's event-only open gesture with that same native modal. PDFs use a validated Blob URL in the browser PDF viewer, raster images and media use native elements, text reads are bounded, and unsupported formats retain an explicit download fallback. Blob URLs are revoked on replacement, close, and case switch.
- Redress renders source Markdown, generated legal outputs, and assistant responses with `arcane/modules/MD.js` sanitized output. Raw HTML and image tokens are made inert before Arcane's first DOM parse; a Redress-specific positive element/attribute allowlist then strips legacy URL-bearing attributes and embedded remote media before the detached fragment is attached. Resolvable case-file links become modal previews.
- `arcane/css/primitives.css` provides the neutral visual vocabulary, and the file-drop, task-progress, summary-strip, file-inspector, and output-panel components provide the promoted behavioral patterns. Redress currently consumes the summary strip directly; the other patterns are ready for incremental screen-level adoption.
- Component and asset links remain repository-relative for `http://localhost:8000/apps/redress/index.html`.

The remaining storage work in `ARCHITECTURE.md`—native providers, migration, watching, and portable export—is separate from this component layer.
