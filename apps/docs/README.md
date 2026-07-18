# Arcane OS Docs app

`apps/docs` is the public documentation application and GitHub Pages adapter for Arcane OS.

The checked-in `public-content.json` is a positive publication allowlist. Packaging copies only those Markdown sources into a generated catalog under `dist/docs`; it never publishes the repository root. The browser runtime then provides local search, the shared safe Markdown viewer, live component specimens, and trusted self-tests.

Build and verify from the repository root:

```powershell
npm run app:package -- docs
npm run app:check -- docs
```

The ordinary GitHub Pages experience has no native Arcane bridge, filesystem authority, shell, account-management capability, or hidden AI credential. A compatible installed host may inject the configured Arcane AI bridge; the app otherwise stays in local-search mode.
