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

## Public corpus boundary

The BOSS source collection contains only approved public records. The current `.gitignore` excludes `business docs/` as a local build input and `documents/` as generated output; the reviewed publication tree is committed under `dist/boss/`.

Do not publish or serve the working directory as a public static site. Build the allowlisted public website instead:

```powershell
npm run build:boss-public
npm run check:boss-public
python -m http.server 8000 --directory dist/boss
```

Only `dist/boss/` is the BOSS website root. Its manifest contains the locked set of approved public records and its `originals/` tree contains their public originals. `public-release-lock.json` pins the approved IDs and source/output hashes so changed files stop the build until deliberately reviewed with `npm run lock:boss-public`.

The Arcane OS packager reads BOSS version and public asset rules from `arcane-package.json`. BOSS uses its content-aware adapter instead of ordinary file copying, so the 500-record public lock, regenerated Markdown, original-file hashes, and internal/restricted leak checks remain mandatory. A normal release is:

```powershell
npm run app:release -- boss
npm run app:check -- boss
```

The BOSS verifier also rejects any public file larger than `95,000,000` bytes. This leaves deployment headroom below GitHub's 100 MB single-file limit; oversized source presentations should have embedded media compressed before the public lock is refreshed.

DBOPFS remains the boundary for user-provided documents. Users can upload or restore their own business material, and the librarian can use uploaded Internal or Restricted material only when the user explicitly requests it in that local browser context. Those uploads are never added to the static release.

## Server deployment runbook

The server deployment unit is the verified `dist/boss/` directory. Never deploy the repository, `apps/boss/`, `business docs/`, or generated working directories. The web server must treat `dist/boss/` as an immutable static document root; it does not need a server-side application process or access to the local Ollama service.

### Build and verify

From a clean checkout of the intended revision:

```powershell
npm ci
npm run build:boss-public
npm run check:boss-public
```

Record the source revision and preserve `dist/boss/PUBLIC_RELEASE.json` and `dist/boss/ARCANE_APP_RELEASE.json` with the release. A failed build or verification stops the deployment. Do not refresh `public-release-lock.json` during deployment merely to make a changed corpus pass; corpus changes require separate review.

### Stage

1. Copy the complete verified `dist/boss/` tree to a new versioned server directory. Do not merge it into the currently served directory.
2. Configure the static host to serve that versioned directory as the site root over HTTPS.
3. Do not add server-side access to DBOPFS, user uploads, local model data, credentials, or repository-only files. Browser-local uploads remain browser-local.
4. Preserve normal MIME types for HTML, JavaScript modules, JSON, Markdown, images, PDFs, and video. Do not rewrite application routes to arbitrary HTML; existing files must remain addressable at their packaged paths.

### Acceptance before promotion

Verify the staged URL in a clean browser profile:

1. `/` loads the packaged BOSS entry point without a directory listing.
2. `/apps/boss/chat.html`, `/apps/boss/library.html`, and `/apps/boss/admin.html` load without missing packaged assets.
3. `PUBLIC_RELEASE.json` is present and matches the staged release.
4. The Library can search the bundled public catalog and open a representative public original.
5. The Librarian reaches the expected local-model unavailable or available state without requiring a server-side Ollama endpoint.
6. Browser developer tools show no failed same-origin package requests on the three application pages.

### Promote and roll back

Promote by changing the host's document-root pointer from the previous versioned directory to the accepted staged directory in one operation, then repeat the acceptance checks on the production URL. Keep the immediately previous verified directory until the new release has passed production smoke testing.

Rollback is the inverse pointer change to that previous verified directory. Do not rebuild, edit files in place, or restore from the repository during an incident. After rollback, repeat the production smoke checks and record the failed release identifier, observed failure, rollback time, and follow-up owner.
