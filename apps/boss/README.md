# BOSS Libraries

BOSS Libraries is a document-and-referral library for business operators. Its AI is a librarian: it retrieves the best available records, links, organizations, and people; explains why they fit; and gives one practical next action. It is not a mentor or professional adviser.

## Canonical prompt and Ollama template

`prompts/system.md` is the single system-prompt source for the BOSS application interface and the Ollama template. Regenerate `Modelfile` after changing the prompt:

```powershell
node apps/boss/scripts/build_modelfile.mjs
```

`Modelfile` intentionally contains `FROM ${BASE_MODEL}`. Substitute the desired Ollama base model when creating a concrete model file; the `SYSTEM` block should remain unchanged.

## Document build

Raw source material remains under `business docs/`. Build one traceable Markdown routing record per source file, plus the manifest, catalog, and conversion report:

```powershell
python apps/boss/scripts/build_library.py
python apps/boss/scripts/build_library.py --check
```

Generated files are written to `documents/`. On first use, the Librarian inspects the browser's DBOPFS `documents` store and asks the user to import the bundled BOSS Markdown records when they are absent or incomplete. The dedicated setup page shows live progress, preserves user-uploaded documents, and returns to the Librarian after a verified import. The Library page searches the manifest directly and does not load the full corpus into an AI request.

## Access boundary

The current `.gitignore` excludes both `business docs/` and `documents/` because this working collection includes internal and restricted records. With those folders present, run BOSS Libraries only in a trusted local environment.

Do not publish or serve the working directory as a public static site. Build the allowlisted public website instead:

```powershell
npm run build:boss-public
npm run check:boss-public
python -m http.server 8000 --directory dist/boss
```

Only `dist/boss/` is the BOSS website root. Its manifest contains the locked set of approved public records, its `originals/` tree contains only their public originals, and it contains no bundled internal or restricted record or binary. `public-release-lock.json` pins the approved IDs and source/output hashes so changed or newly classified files stop the build until deliberately reviewed with `npm run lock:boss-public`.

The Arcane OS packager reads BOSS version and public asset rules from `arcane-package.json`. BOSS uses its content-aware adapter instead of ordinary file copying, so the 500-record public lock, regenerated Markdown, original-file hashes, and internal/restricted leak checks remain mandatory. A normal release is:

```powershell
npm run app:release -- boss
npm run app:check -- boss
```

The BOSS verifier also rejects any public file larger than `95,000,000` bytes. This leaves deployment headroom below GitHub's 100 MB single-file limit; oversized source presentations should have embedded media compressed before the public lock is refreshed.

DBOPFS remains the boundary for user-provided documents. Users can upload or restore their own business material, and the librarian can use uploaded Internal or Restricted material only when the user explicitly requests it in that local browser context. Those uploads are never added to the static release.
