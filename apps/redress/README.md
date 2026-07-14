# Redress Legal Workbench

Redress is an Arcane OS workspace for organizing a legal matter around its actual record, then using AI for analysis, drafting, research planning, and hearing preparation. This first version supports family and criminal matters and runs in the browser with private Origin Private File System (OPFS) storage.

Redress is record-first: imported originals remain the source of truth, generated Markdown stays paired with those originals, and AI prompts require exact local source paths for material factual claims. It does not file, serve, send, sign, or contact anyone automatically.

## Run Redress

Redress imports shared Arcane modules from the repository root. Do not serve only the `apps/redress` directory.

From the Arcane OS repository root:

```powershell
npm ci
python -m http.server 8000
```

Open:

<http://localhost:8000/apps/redress/index.html>

The install manifest also starts at `apps/redress/index.html`.

## What works in this first version

- Create, switch between, and reopen separate case workspaces; record the case name, number, matter type, party role, jurisdiction, court, forum level, stage, next date, and current goals.
- Import an existing filing-by-filing case folder, add newly filed PDFs directly, or add mixed evidence files through the workspace.
- Browse the case through a nested logical file tree while the underlying files remain in browser-private DBOPFS storage.
- Preserve imported bytes and record source provenance, including original name and relative path, stored path, media type, size, import time, and SHA-256 status.
- Preserve compliant filed-PDF names and pair each filing with same-basename Markdown.
- Give evidence a descriptive who-and-what name, without inventing a date, and create a same-basename Markdown description.
- Continue an import when AI description generation is unavailable by writing a review-required fallback description; the raw original remains available.
- Review an original, its provenance, its generated description, and request a new description after configuring AI. Double-click or press Enter on a case-tree file, or choose **Open original**, to use the shared Arcane modal.
- Preview validated PDFs with the browser's built-in PDF tools; view raster images, audio, video, Markdown, and text-oriented files with native browser elements. Formats without a safe native viewer stay in the modal with an explicit original-file download.
- Read source Markdown, saved work product, Analysis, Draft, Research, Argument, and assistant responses as formatted GitHub-Flavored Markdown through Arcane's sanitized Markdown module.
- Run chronology, issue-spotting, possible-contempt, potential-sanctions, statement-consistency, proof-gap, family-case-map, and criminal-case-map analyses.
- Build working Requests for Order (RFOs), responses, replies, briefs, memoranda, requests for judicial notice, declarations, motions, criminal motions or oppositions, emails, and hearing outlines.
- Build a jurisdiction-aware legal research plan across local, municipal, state, federal, national, international, and global authority levels.
- Prepare a timed oral argument, learn Conclusion, Rule, Application, Conclusion (CRAC), and start a one-question-at-a-time Socratic practice conversation against the record.
- Ask case-aware questions in the Redress assistant.
- See how many Markdown descriptions were selected or omitted for each AI result; large-case requests use query-ranked descriptions plus a bounded path inventory and are explicitly labeled non-exhaustive.

Generated analysis and drafts are work product. They are not filed documents, judicial findings, verified testimony, or legal authority.

## Canonical case folders

Redress uses this logical structure:

```text
case/
|-- Filing by Filing/
|   |-- PDF/
|   `-- MD/
|-- Evidence/
|   |-- Raw/
|   `-- MD/
`-- Work Product/
    |-- Analysis/
    |-- Drafts/
    |-- Oral Argument/
    `-- Research/
```

### Filing by Filing

`Filing by Filing/PDF` contains filed PDFs. Preserve the established naming convention:

```text
YY-MM-DD [PERSON OR COURT] - TITLE.pdf
```

The Markdown counterpart belongs in `Filing by Filing/MD` and uses the identical basename:

```text
Filing by Filing/PDF/24-10-28 [COURT] - ORDER.pdf
Filing by Filing/MD/24-10-28 [COURT] - ORDER.md
```

Redress preserves an already compliant filed-PDF name. It does not silently reinterpret the filer, filing date, or title.

### Evidence

`Evidence/Raw` holds the unchanged evidence file. It may contain documents, messages, email, images, audio, video, spreadsheets, archives, or other relevant formats.
Nested source folders are preserved beneath `Evidence/Raw`, with the same nested path beneath `Evidence/MD`.

Evidence names should identify who and what the item concerns:

```text
Evidence/Raw/[UNDATED] [BRANDON MILLER] - Payment Record.pdf
Evidence/MD/[UNDATED] [BRANDON MILLER] - Payment Record.md
```

A date is included only when the source reliably supports it. Redress does not invent a date to make a filename look complete. If AI cannot safely identify who or what, the fallback name remains conservative and the Markdown flags the item for review.

The raw and Markdown filenames always share the same basename even when the raw file is not a PDF.

## Bulk case-folder import

Use **Import case folder**, drag the complete folder onto **Existing case folder**, or use **Choose folder**. The folder picker relies on browser directory-selection support; if folder drop is not available in a browser, use the picker.

The importer recognizes:

- `Filing by Filing/PDF`
- `Filing by Filing/MD`
- `Evidence/Raw`
- `Evidence/MD`

It copies recognized files into the active Redress workspace. It does not modify or rename files in the source folder on disk.

The bulk importer intentionally excludes material that is not part of the canonical filing-by-filing record:

- `Court provided merged PDFs` and other merged-packet folders;
- rendered-page images and page-render caches;
- temporary, cache, staging, and scratch folders;
- QA, review, and generated-preview folders;
- prior tool output and generated `Analysis`, `Drafts`, or `Research` work product; and
- hidden Redress application metadata.

Add a source file to the canonical folder if it was skipped but should be part of the record. Keep merged court packets outside the canonical import; use the individual filing PDFs instead.

## Provenance and Markdown descriptions

For each imported original, Redress stores the original filename and relative path alongside its canonical case path. It also records available file metadata and attempts a SHA-256 hash before AI description work. A renamed imported copy keeps its original identity in provenance metadata.

The companion Markdown includes:

- a link to the paired raw file;
- original filename and relative path;
- media type, size, hash status, and import time;
- the identified document type, people, and supported date;
- requests or relief reliably identified in the item;
- a concise summary and potential relevance;
- extraction method, limitations, and human-review status; and
- a bounded extracted-text preview when browser-readable text is available.

Browser text extraction currently handles text-oriented formats such as TXT, Markdown, CSV, email text, HTML, JSON, logs, RTF, and XML. PDF OCR, image understanding, audio transcription, video transcription, and full office-document extraction are not bundled into this first browser pass. Those files are still preserved, but their initial description may be metadata-only and marked for review.

File preview is separate from AI extraction. Redress displays PDFs, raster images, audio, video, Markdown, and bounded text inside the shared native-dialog modal without a third-party viewer. HTML, XML, and SVG are shown as source text rather than executed. Office documents, archives, executables, unknown binaries, corrupt files, and browser-unsupported media provide a download fallback without changing the stored original.

Rendered Markdown uses `arcane/modules/MD.js` with its sanitized output. Redress first makes raw HTML and Markdown image syntax inert so the browser cannot start a subresource request during Arcane's DOM sanitization pass. Before attaching the detached result, it also applies a positive Markdown HTML/attribute allowlist, removes URL-bearing legacy attributes and embedded remote media, and neutralizes unavailable case-relative links. Links that resolve to an imported case file open that file through the same preview modal.

AI tasks do not silently treat generated drafts as evidence. Redress selects only filing/evidence descriptions (and future authority records), ranks them against the current request, supplies a separate file-path inventory, and states included/omitted coverage in the saved work product. This bounded retrieval is not a substitute for a batch whole-record review.

Imported content is treated as untrusted evidence, not as instructions to the AI. Descriptions do not decide authenticity, admissibility, credibility, or legal effect.

## Configure AI

Open **AI settings** in the Redress navigation and choose one provider.

### Local Ollama

Choose **Local Ollama**, enter the model name, and keep Ollama running. The supplied Redress model is `REDRESS:120b`, built from `gpt-oss:120b`.

The canonical system prompt is `apps/redress/prompts/system.md`. Regenerate the checked-in Ollama template after changing that prompt:

```powershell
node apps/redress/scripts/build_modelfile.mjs
```

The generated `apps/redress/Modelfile` uses the 120-billion-parameter GPT-OSS base model:

```text
FROM gpt-oss:120b
```

Pull the base model, then create the local Redress model:

```powershell
ollama pull gpt-oss:120b
ollama create REDRESS:120b -f apps\redress\Modelfile
```

The 120B model is large; make sure the Ollama host has sufficient memory and storage before pulling it.

### OpenAI API

Choose **OpenAI API** and supply an API key. Arcane currently stores that key with the local browser profile; an operating-system-backed native secret vault is not part of this version.

Case context sent for analysis or description work goes to the selected AI provider. Use a suitable local model when matter content should not leave the machine.

## Legal workflows

Redress prompts require the AI to:

- cite each material case fact with an exact local source path;
- distinguish a record fact, user statement, inference, and unknown;
- ask for missing jurisdiction, court level, posture, or effective date when it changes the answer;
- avoid inventing laws, cases, holdings, quotations, filings, deadlines, elements, or outcomes;
- distinguish supplied authority from authority that still needs retrieval and verification;
- map supporting facts, contrary facts, counterarguments, and missing proof;
- use CRAC where it clarifies analysis;
- put unsupported draft details in visible `[VERIFY]` placeholders; and
- leave filing, signing, service, sending, and every other external act to the user.

The prompt is designed to produce useful work, not merely disclaimers. Even so, every draft and legal conclusion must be checked against the original record, current controlling authority, local rules, and the actual procedural posture.

## Current boundaries

### Official law and current authority

This version builds research plans and can analyze authority that the user imports. It does not yet have a live connector that retrieves, updates, validates, or negative-checks official law. It cannot certify that a statute, rule, case, deadline, or local practice is current.

Verify every legal authority, quotation, effective date, court rule, filing requirement, and deadline against an official source. A model-generated citation is not authority.

### Native and portable storage

This version uses DBOPFS explicitly. Its nested case tree is a Redress logical structure over browser-private storage.

The following shared Arcane capabilities are planned but are not complete here:

- a hierarchical shared DBOPFS API for all apps;
- a native filesystem provider;
- a portable native-first, DBOPFS-fallback provider;
- verified OPFS-to-native and native-to-OPFS migration;
- native folder watching, synchronization, and an operating-system file explorer; and
- production-scale resumable ingestion and binary-safe case export.

Redress does not expose unrestricted Node.js or operating-system filesystem access to the browser renderer.

## Privacy and record safety

- DBOPFS data is private to this browser origin and profile, but it is still local application data, not an encrypted evidence vault.
- Clearing browser site data or changing origins can make the workspace unavailable. Keep authoritative originals outside Redress.
- A production-grade case export and native-storage migration workflow is not included yet.
- The chosen AI provider receives the case context required for a request.
- Minimize unnecessary personal identifiers, information about children, medical material, sealed records, intimate material, account numbers, and privileged communications.
- Redress cannot guarantee that use of an AI system creates or preserves attorney-client privilege or work-product protection.
- Preserve authoritative originals, metadata, hashes, and chain-of-custody information outside generated descriptions.

## Developer map

- `index.html` — application shell and the Workspace, Analyze, Draft, Research, Argue, and assistant interfaces.
- `redress-modal.css` — theme-aware Redress form styling applied inside the shared Arcane modal component.
- `modules/FilePreview.js` — native-preview classification, media-type recovery, and PDF signature validation.
- `modules/MarkdownSafety.js` — pre-DOM raw-HTML and image neutralization for private case Markdown.
- `modules/CaseModel.js` — safe case paths, filing/evidence conventions, companion mapping, and nested logical trees.
- `modules/CaseImporter.js` — recursive/pruned folder collection, raw-first pair commits, collision versioning, and description jobs.
- `modules/CaseRepository.js` — case metadata, stored files, provenance fields, hashing, collisions, and bounded Markdown context.
- `modules/EvidenceDescriptor.js` — conservative evidence naming, browser text preview, AI/fallback descriptions, and companion Markdown.
- `modules/LegalPrompts.js` — pure prompt builders and record/source discipline.
- `modules/LegalAssistant.js` — Arcane AI provider bridge for analysis, drafts, research, argument, and chat.
- `prompts/system.md` — canonical Redress system prompt.
- `scripts/build_modelfile.mjs` — deterministic Modelfile generator.
- `ARCHITECTURE.md` — planned shared storage and native-provider boundaries.
- `COMPONENTS.md` — implemented Arcane component boundaries for the provider-backed file tree, assistant drawer, app bar, native dialog modal, shared primitives, and composable behavior panels.

## Tests

Run these directly from the Arcane OS repository root:

```powershell
node --test apps/redress/test/*.test.mjs

# Shared components plus Redress plus the machine bundle:
npm run check

# Or run focused suites:
node --test apps/redress/test/case-repository.test.mjs
node --test apps/redress/test/case-model.test.mjs
node --test apps/redress/test/case-importer.test.mjs
node --test apps/redress/test/legal-prompts.test.mjs
node --test apps/redress/test/modelfile.test.mjs
```

The Redress tests cover the app shell, path safety, nested import/pairing, collision behavior, repository persistence and bounded context, prompt escaping and legal safeguards, chat-history bounds, workflow behavior, and exact parity between the canonical system prompt and generated Modelfile. The root suite also covers the shared file manager, assistant, app bar, modal, primitives, and behavior-panel contracts.

For a real browser check of PDF, Markdown, plain-text, and unsupported-format modal behavior, open `http://localhost:8000/apps/redress/test/file-preview-smoke.html`. The fixture creates a disposable browser-private case, uses a unique hostile-Markdown network probe, and provides its own cleanup action to restore the previously active case.
