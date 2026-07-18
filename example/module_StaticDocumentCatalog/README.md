# StaticDocumentCatalog example

`StaticDocumentCatalog` validates a versioned positive inventory, searches its
metadata deterministically, fetches only declared same-directory text, verifies
the exact UTF-8 byte size and SHA-256 digest, and can build bounded context that
is explicitly labeled untrusted.

The synthetic page injects an in-memory `fetchImpl`; it performs no network or
persistent-storage operation. Production callers provide a reviewed manifest,
an absolute HTTP(S) `baseURL`, and optionally a scoped cache exposing
`get(key)`, `set(key, value)`, and `delete(key)`. Cache failures are nonfatal,
cache operations have a bounded timeout, and cached text is reverified before
use. The module never enumerates storage,
chooses a persistence namespace, renders Markdown, or decides which files are
public.

A manifest has `{version, documents}`. Each document declares `id`, normalized
relative `path`, `kind`, `title`, optional `summary`, `tags`, exact `byteSize`,
lowercase `sha256`, optional `{id, level, text}` headings, and optional
`examples` and `screenshots` path arrays. Unknown fields, traversal, alternate
separators, malformed encodings, oversized values, and case-colliding IDs or
paths fail closed.

Public methods are `list()`, `get(id)`, `search(query, options)`,
`hydrate(id, options)`, and `buildContext(query, options)`. Returned records,
results, and context snapshots are frozen.
