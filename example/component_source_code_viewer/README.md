# Source-code viewer component example

This example demonstrates `arcane/components/source-code-viewer.html`, a reusable viewer for bounded source text.

The parent supplies source text plus optional title, original path, language, and repository URL metadata. The component exposes `render`, `load`, `clear`, `fail`, `focus`, and `focusLine` methods together with persistent `.ready` state and the `source-code-viewer-ready` event.

Source lines are created with `textContent`; source HTML, custom elements, event attributes, and JavaScript-like strings never enter an HTML parser. The component provides accessible loading, empty, ready, and error states, programmatic line focus, a native repository link, horizontal scrolling for intrinsically preformatted code, Arcane theme inheritance, visible focus, and forced-colors support.

Run the example through an HTTP server rooted at the repository so `HTMLImport` can resolve the shared component and modules.
