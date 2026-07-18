# Document inspector example

`arcane/components/document-inspector.html` is a domain-neutral, same-origin document review surface. A parent application supplies a PDF URL, optional positive-integer `pdfPage`, Markdown URL, metadata labels, review options, existing review state, and app-specific wording through `loadDocument(...)`. When `pdfPage` is supplied, the inspector opens the embedded PDF at that page and includes the page in the frame's accessible title. The component emits `document-review-change`; the parent owns persistence and business outcomes.

The component provides keyboard-operable tabs, a titled PDF frame, sanitized Markdown with remote media and links disabled, text search with an announced match count, metadata, notes, and configurable review status. It does not decide evidentiary meaning, persist records, call providers, or load cross-origin sources.
