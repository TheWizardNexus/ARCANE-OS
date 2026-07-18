# Arcane OS Docs app

`apps/docs` is the public documentation application and GitHub Pages adapter for Arcane OS.

The checked-in `public-content.json` is a positive publication allowlist. Packaging copies only the named Markdown, reviewed source, and screenshot inputs into a generated catalog under `dist/docs`; it never publishes the repository root. Source files are copied to `.txt` paths so the catalog snapshot is inert. The browser runtime then provides local search, safe Markdown and source viewers, live component specimens, trusted self-tests, and automatic integrity-checked caching of this public corpus in an Arcane Docs-scoped OPFS namespace.

Build and verify from the repository root:

```powershell
npm run app:package -- docs
npm run app:check -- docs
```

The ordinary GitHub Pages experience has no native Arcane bridge, filesystem authority, shell, account-management capability, or hidden AI credential. A compatible installed host may inject the configured Arcane AI bridge and ground answers in bounded excerpts from the reviewed public documentation and source snapshot; the app otherwise stays in local-search mode. The snapshot is intentionally not the entire checkout and never includes untracked or private files.
