# Static document publication tooling

`publication.mjs` materializes and verifies a public, static-document catalog from an application-owned positive allowlist. It is build tooling, not a browser filesystem API.

The caller supplies:

- a real source root;
- a policy JSON file inside that root;
- an isolated package staging root;
- the package-relative public application root.

Policy schema version 1 remains supported for `public` Markdown documents and reviewed screenshots. Schema version 2 adds an explicit reviewed-source inventory. Source entries accept only bounded UTF-8 JavaScript, HTML, CSS, and JSON-family text selected by literal path; minified, generated, vendored, private, and untracked content stays outside the catalog unless a reviewer deliberately changes the positive inventory. Screenshot sources must preserve a supported image extension. All paths are literal, relative, link-free, case-distinct, and bounded.

The builder canonicalizes text line endings to LF, preserves Markdown paths below `catalog/documents`, and copies reviewed source below `catalog/sources` with an added `.txt` suffix so an HTML source file is served as inert text. It copies screenshot bytes exactly, extracts Marked-compatible headings and bounded code search terms, records original path, language, media type, published byte size, and SHA-256, then derives the catalog version from the complete reviewed inventory. Heading extraction uses the viewer's deterministic identifier rules and fails closed on named HTML entities it cannot reproduce without a browser DOM. The verifier reconstructs that expectation from source, validates the strict `StaticDocumentCatalog` contract, compares exact published bytes, and rejects every extra generated catalog, source, or screenshot file.

Applications keep product taxonomy and publication choices in their own policy. A thin package adapter calls:

```js
import {
    buildDocumentCatalogPublication,
    verifyDocumentCatalogPublication
} from '../../../tools/document-catalog/publication.mjs';
```

Neither operation enumerates arbitrary repository content for publication. Content not named by policy is never copied into the generated catalog.
