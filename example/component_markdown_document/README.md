# Arcane Markdown document component

## Overview

`arcane/components/markdown-document.html` is a source-aware, read-only Markdown renderer. It uses the shared `MD.safeRendered` result as its first pass and then applies a stricter positive element, attribute, URL-protocol, and same-origin asset policy before content reaches the component output.

The component generates collision-free heading identifiers and a native-link table of contents. Same-origin `.md` links are never followed directly: the parent receives a cancelable navigation event and may supply an `onNavigate` callback to map the source URL into its own route.

The component does not fetch, persist, authorize, or choose application routes. Those decisions remain with the parent.

## Run the example

Serve the repository root over HTTP and open `/example/component_markdown_document/`.

```powershell
python -m http.server 8000
```

The example is entirely synthetic. Its relative image resolves to an existing same-origin Arcane asset, and its Markdown link is handled locally by the parent callback.

## Readiness

The host follows Arcane's dual readiness contract. It sets `.ready=true` before emitting `markdown-document-ready`. Consumers should listen for the event and check the persistent property; `WaitForComponent.js` handles both load orders:

```js
const viewer=await waitForComponent(element,{
    event:'markdown-document-ready',
    methods:['configure','load','render'],
    property:'ready'
});
```

## Public API

| API | Purpose |
|---|---|
| `configure(options)` | Sets labels, the default source URL, table-of-contents visibility, and the optional Markdown-route callback. |
| `load(source, options)` | Enters loading state and resolves a string, promise, or provider function. Providers may return a string or `{ markdown, sourceURL }`. |
| `render(markdown, options)` | Synchronously renders a Markdown string with an optional source URL. |
| `clear()` | Removes content and enters the empty state. |
| `fail(error)` | Removes content and enters the accessible error state. |
| `focus()` | Moves programmatic focus to the first rendered heading, the article, or the current state message. |
| `focusFragment(fragment)` | Moves programmatic focus to a rendered heading identifier and scrolls it into view. Returns whether a target was found. |
| `value` | Gets the current Markdown or renders an assigned string. |
| `sourceURL` | Gets or sets the current same-origin Markdown source URL. |
| `state` | Reports `loading`, `empty`, `error`, or `ready`. |
| `tableOfContents` | Returns a copy of generated `{ id, level, text }` entries. |

`configure` accepts:

```js
viewer.configure({
    sourceURL:new URL('./guides/start.md',document.baseURI).href,
    showTableOfContents:true,
    labels:{
        content:'Guide content',
        empty:'No guide is selected.',
        error:'Unable to display this guide.',
        loading:'Loading guide…',
        tableOfContents:'On this page'
    },
    onNavigate(detail){
        routeDocument(detail.targetURL);
    }
});
```

`sourceUrl` is accepted as an input alias, while the public property and event field use `sourceURL`.

## Events

| Event | Detail | Purpose |
|---|---|---|
| `markdown-document-ready` | `{ component, state }` | Public methods are installed and `.ready` is true. |
| `markdown-document-state` | State-specific detail | Every state transition. |
| `markdown-document-loading` | `{ state, sourceURL }` | An asynchronous load began. |
| `markdown-document-empty` | `{ state, sourceURL }` | No renderable content remains. |
| `markdown-document-rendered` | `{ state, sourceURL, characters, headings }` | Content passed both sanitizers and rendered. |
| `markdown-document-error` | `{ state, sourceURL, message }` | Loading or rendering failed; the visible message remains generic. |
| `markdown-document-navigate` | `{ kind, href, sourceURL, targetURL, fragment }` | A safe link was activated. The event is cancelable. |

Navigation `kind` is `markdown`, `fragment`, or `link`. Same-origin Markdown navigation is always prevented at the browser level and routed through the event and `onNavigate`. Fragment navigation focuses the matching heading. Other safe links retain native behavior unless the parent cancels the event.

## Security and privacy boundary

- Raw output is never assigned to the article. Rendering is `MD.safeRendered` -> inert template -> positive element/attribute filtering -> article insertion.
- `script`, active embeds, forms, SVG/MathML, `html-import`, and every other custom element are removed with their complete subtrees.
- URL attributes accept only an explicit protocol set. Script, data, blob, file, and FTP URLs are rejected.
- Images and other passive Markdown assets must resolve to same-origin HTTP(S) URLs relative to `sourceURL`; cross-origin and credential-bearing asset URLs lose their `src` before insertion.
- Cross-origin HTTP(S) links are user-activated, open with `noopener noreferrer`, and send no referrer. The component performs no background network request itself.
- The parent remains responsible for catalog approval, content-size bounds, fetch integrity, route authorization, and any persistence.

## Accessibility and theme behavior

The component uses native `article`, `nav`, heading, list, and anchor semantics. Loading, empty, and error text uses a polite atomic status region; loading is also exposed with `aria-busy`. Generated heading targets support programmatic focus, all actions remain native keyboard links, and focus has visible theme-aware styling including forced-colors support.

The component layers Arcane layout, theme, and primitives before its own styles. The host application must still load `theme.css` and `ThemeBootstrap.js` so saved light, dark, system, custom, reduced-motion, and contrast choices remain authoritative.

## Dependencies

- `arcane/components/markdown-document.html`
- `arcane/modules/MD.js`
- `arcane/modules/WaitForComponent.js` (consumer convenience)
- `arcane/modules/HTMLImport.js`
- Arcane layout, theme, and primitives styles
