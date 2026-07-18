# Static document publication tooling

`publication.mjs` materializes and verifies a public, static-document catalog from an application-owned positive allowlist. It is build tooling, not a browser filesystem API.

The caller supplies:

- a real source root;
- a policy JSON file inside that root;
- an isolated package staging root;
- the package-relative public application root.

Policy schema version 1 accepts only `public` documents and reviewed screenshots. Document sources must be UTF-8 Markdown files. Screenshot sources must preserve a supported image extension. Paths are literal, relative, link-free, case-distinct, and bounded.

The builder canonicalizes Markdown line endings to LF, preserves each source-relative path below `catalog/documents`, copies screenshot bytes exactly, extracts Marked-compatible headings, records published byte size and SHA-256, and derives the catalog version from the complete reviewed document and screenshot inventory. Heading extraction uses the viewer's deterministic identifier rules and fails closed on named HTML entities it cannot reproduce without a browser DOM. The verifier reconstructs that expectation from source, validates the strict `StaticDocumentCatalog` contract, compares exact published bytes, and rejects every extra generated catalog or screenshot file.

Applications keep product taxonomy and publication choices in their own policy. A thin package adapter calls:

```js
import {
    buildDocumentCatalogPublication,
    verifyDocumentCatalogPublication
} from '../../../tools/document-catalog/publication.mjs';
```

Neither operation enumerates arbitrary repository Markdown for publication. Content not named by policy is never copied into the generated catalog.
