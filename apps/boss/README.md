# BOSS Libraries

BOSS Libraries is a document-and-referral library for business operators. Its AI is a librarian: it retrieves the best available records, links, organizations, and people; explains why they fit; and gives one practical next action. It is not a mentor or professional adviser.

## Canonical prompt and Ollama template

`prompts/system.md` is the single system-prompt source for the web app and the Ollama template. Regenerate `Modelfile` after changing the prompt:

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

Generated files are written to `documents/`. On first use, the chat seeds the generated Markdown records into the app's local `documents` store. The Library page searches the manifest directly and does not load the full corpus into an AI request.

## Access boundary

The current `.gitignore` excludes both `business docs/` and `documents/` because this working collection includes internal and restricted records. With those folders present, run BOSS Libraries only in a trusted local environment.

Do not publish the working directory as a public static site. A public deployment must package only approved records, keep restricted files outside the static web root, and enforce authorization on a server before returning restricted metadata or content. Client-side filters are discovery safeguards, not access control.
