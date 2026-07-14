# Redress Architecture

## First-pass target

Redress is an Arcane legal workspace for family and criminal matters. The first pass is browser-capable and OPFS-first. It establishes the case filesystem, bulk import, provenance, and AI-ingestion boundaries without coupling legal behavior to Arcane's shared storage code.

Native filesystem support is a later shared Arcane capability. Redress must not invent an app-local native bridge or expose Node filesystem access to the renderer.

## Canonical case workspace

The target hierarchical-provider layout roots every case at `cases/<case-id>/` and uses this tree:

```text
cases/<case-id>/
|-- case.json
|-- Filing by Filing/
|   |-- PDF/
|   `-- MD/
|-- Evidence/
|   |-- Raw/
|   `-- MD/
|-- Work Product/
|   |-- Analysis/
|   |-- Drafts/
|   |-- Oral Argument/
|   `-- Research/
`-- .redress/
    |-- provenance.jsonl
    `-- ingestion.jsonl
```

- `Filing by Filing/PDF` contains filed PDFs using the existing `YY-MM-DD [PERSON OR COURT] - TITLE.pdf` convention.
- `Filing by Filing/MD` contains the extracted Markdown counterpart with the identical basename.
- `Evidence/Raw` accepts any supported raw evidence type. It is the evidence equivalent of the filing PDF folder.
- `Evidence/MD` contains one description or transcription per raw item, using the identical descriptive basename.
- Drafts, research, and analysis are generated work product; they are never treated as filed documents or raw evidence.
- `.redress` is application metadata and is hidden from ordinary document views.

`case.json` records the case identifier, matter type, parties, court, jurisdiction, storage backend, creation time, and schema version. Paths inside records are always relative to the case root.

The implemented first browser pass represents this tree logically in each case record while storing blobs in a flat DBOPFS table. It does not yet materialize `cases/<case-id>/` as nested OPFS directories or write `.redress` JSONL logs. Those are shared-provider migration targets, not claims about the current build.

## Import and provenance

Dragging a complete case folder should recognize `Filing by Filing/PDF` and `Filing by Filing/MD`. `Court provided merged PDFs`, rendered-page caches, QA folders, temporary folders, and tool output are not imported into the canonical case tree.

For every imported raw file, Redress must:

1. Stream the bytes into a staging path.
2. Calculate SHA-256 before AI processing.
3. Record the original filename and original relative path.
4. Detect duplicates by hash without discarding provenance.
5. Classify the item as a filing, evidence, or unsupported input.
6. Persist the raw bytes unchanged.
7. Generate or associate the Markdown counterpart.
8. Append a completed or failed ingestion record.

Filed PDF names are preserved. Evidence names are grounded in the content and should identify who and what the evidence concerns. Include a date only when the source supports one; never invent a date. The Markdown filename must match the final raw-evidence basename.

Renaming an imported copy does not erase its origin. Each provenance record includes at least:

```json
{
  "id": "stable-ingestion-id",
  "originalName": "source filename",
  "originalRelativePath": "source/folder/file.ext",
  "storedPath": "Evidence/Raw/descriptive name.ext",
  "sha256": "hex digest",
  "size": 0,
  "mimeType": "application/octet-stream",
  "importedAt": "ISO-8601 timestamp",
  "descriptionPath": "Evidence/MD/descriptive name.md",
  "status": "complete"
}
```

Name collisions are resolved deterministically while preserving the hash and source name. AI naming and description generation run as resumable ingestion jobs; a failed description must not remove the raw file.

## Hierarchical storage contract

Arcane storage providers should share an asynchronous, namespace-and-relative-path contract:

```js
get(namespace, path, options)
set(namespace, path, value, options)
readFile(namespace, path, options)
writeFile(namespace, path, data, options)
listEntries(namespace, path, options)
stat(namespace, path)
mkdir(namespace, path, options)
delete(namespace, path, { recursive })
move(namespace, from, to, options)
transaction(operations)
```

`listEntries` returns structured entries rather than bare names:

```js
{ name, path, kind, size, type, lastModified }
```

All providers use the same path rules. Paths are relative, `/`-separated, and normalized. Absolute paths, drive or UNC paths, `..`, empty segments, control characters, reserved device names, and traversal through symlinks or reparse points are rejected. Reads must not create missing directories.

The current flat DBOPFS methods remain the compatibility layer used by the implemented Redress browser pass. After the shared providers exist, Redress can move to this hierarchical contract without changing its legal path schema.

## Target provider selection

The shared Arcane storage layer should expose three intentionally different choices:

- `dbopfs` always uses Origin Private File System storage.
- `dbnativefs` always uses Arcane's native app filesystem and fails clearly when that capability is unavailable.
- `dbfs` is portable: it selects native storage during initialization when authorized and otherwise selects DBOPFS.

`dbfs` exposes its selected backend. Selection happens once per session and is recorded in `case.json`. It must not switch providers after an operation fails; per-operation fallback could split one case across two stores. Moving a case between providers is an explicit, verified migration that copies bytes, verifies hashes, and then changes the case binding.

Apps that require browser-private storage use `dbopfs` explicitly. Apps that require native files use `dbnativefs` explicitly. Only apps designed for either environment use `dbfs`.

## Native filesystem capability

The existing `Arcane.storage` JSON key-value service remains for small settings and is not reused for legal files.

The native provider will be implemented in Arcane Core and exposed to the renderer as `Arcane.files`. It will use explicit `filesystem.read` and `filesystem.write` capabilities and an app-scoped root such as:

```text
%LOCALAPPDATA%/Arcane OS/apps/<app-id>/files
```

The renderer never receives unrestricted Node or operating-system filesystem access. The core validates every relative path, confines access to the app root, rejects symlink and reparse-point escapes, applies size limits, and audits mutations.

Legal files can exceed Arcane's framed RPC limit, so binary transfer is chunked:

```text
filesystem.read.open -> filesystem.read.chunk -> filesystem.read.close
filesystem.write.begin -> filesystem.write.chunk -> filesystem.write.commit
                                             `-> filesystem.write.abort
```

Writes use a temporary file, incremental hashing, flush, and atomic rename on commit. Interrupted uploads are recoverable and cannot expose a partial destination file. External folders, if supported later, require an explicit user grant and are separate from automatic app storage.

## Ownership boundary

Shared Arcane code owns:

- path validation and the storage-provider contract;
- hierarchical OPFS, native, portable, and in-memory providers;
- native capabilities, chunk transport, confinement, and auditing;
- provider-aware file entities;
- a lazy hierarchical file explorer;
- folder-drop traversal, collision reporting, and a domain-neutral `storage-files-added` event.

Redress owns:

- the case tree and schema;
- filing and evidence classification;
- naming, extraction, OCR, transcription, and Markdown templates;
- provenance, deduplication, and ingestion queues;
- legal research, issue spotting, drafting, oral-argument coaching, CRAC instruction, and Socratic workflows.

The shared explorer reports successful storage operations. It does not contain legal prompts or automatically rename evidence.

## Rollout

### Phase 1: OPFS legal workspace (implemented app layer)

- Create and open logical canonical case workspaces over flat DBOPFS.
- Import `Filing by Filing` trees and mixed evidence files.
- Hash raw files and retain provenance in the case record.
- Generate paired Markdown while retaining raw files when AI is unavailable.
- Render the logical hierarchy in Redress's case tree.

### Phase 2: shared hierarchical provider boundary

- Extract path validation and a provider contract.
- Add hierarchical OPFS operations and lazy explorer rendering.
- Inject providers into `FileEntity` and the file explorer.
- Keep legacy flat DBOPFS calls working for BOSS and PreCrisis.
- Add an in-memory provider for deterministic contract tests.

### Phase 3: native storage

- Add `Arcane.files`, filesystem capabilities, and chunked transfers.
- Implement app-root confinement, atomic writes, hashing, and audit records.
- Add `dbnativefs` and initialization-only `dbfs` fallback.
- Add explicit OPFS-to-native and native-to-OPFS case migration.

### Phase 4: scale and recovery

- Add lazy pagination for large evidence collections.
- Resume interrupted ingestion and native transfers.
- Add versioned case export/import with binary-safe archives.
- Add integrity scans that reconcile files, Markdown, hashes, and manifests.

## Verification

Future provider contract tests should cover nested binary round trips, directory listing, metadata, recursive deletion, moves, concurrent writes, and identical errors across backends. Security tests should cover traversal, absolute paths, device names, symlinks, Windows reparse points, cross-app isolation, capability denial, and interrupted atomic writes.

Current Redress integration tests cover `24FL001068`-style path import, merged/render-cache exclusion, exact filing-name preservation, evidence naming without invented dates, matching raw/Markdown basenames, deterministic name collisions, provenance, and missing-description generation. Future shared-provider tests must add duplicate-hash reconciliation, resumable ingestion, and backend migration with hash verification.
