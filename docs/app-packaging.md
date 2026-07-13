# Arcane OS application packaging

The Arcane OS application packager creates verified static distribution roots from configured Arcane applications under `apps/`. These packages carry the application interface and shared runtime; they do not redefine the application as a website or limit its native Arcane capabilities. Sources come from the current workspace and completed packages go to `dist/<app-id>`. Each package keeps the repository-shaped `apps/`, `arcane/`, and allowlisted `node_modules/` paths expected by Arcane application interfaces.

## Routes

The npm scripts are convenient wrappers around `node tools/package-app.mjs`:

| Task | npm route | Direct CLI |
|---|---|---|
| List app directories and versions | `npm run apps:list` | `node tools/package-app.mjs list` |
| Inspect effective rules and size | `npm run app:inspect -- <app>` | `node tools/package-app.mjs inspect <app>` |
| Package the current version | `npm run app:package -- <app>` | `node tools/package-app.mjs package <app>` |
| Package every configured app | `npm run app:package -- --all` | `node tools/package-app.mjs package --all` |
| Release with a patch bump | `npm run app:release -- <app>` | `node tools/package-app.mjs release <app>` |
| Verify an existing package | `npm run app:check -- <app>` | `node tools/package-app.mjs check <app>` |
| Verify every public package plus BOSS publication policy | `npm run check:public-apps` | `npm run test:boss-public && node tools/package-app.mjs check --all` |
| Change only the source version | `npm run app:bump -- <app> <level-or-version>` | `node tools/package-app.mjs bump <app> <level-or-version>` |

`list`, `inspect`, `package`, `check`, and `bump` accept `--json` for machine-readable output where applicable. Package and version operations accept `--dry-run`. `build` aliases `package`, and `verify` aliases `check`.

`npm run check` and the tracked pre-push hook include `check:public-apps`. A normal push therefore fails when any configured `dist/<app-id>` package is missing, stale, or fails exact inventory verification, or when the BOSS public-release policy test fails. The compiled Microsoft NT native machine-bundle gate remains a separate later step.

## Semantic versions

The app's `arcane-package.json` is the authoritative version source. PWA `manifest.json` files and asset query strings are not treated as versions.

- `package <app>` rebuilds the current version without changing source files.
- `release <app>` defaults to `--bump patch`.
- `--bump major`, `minor`, `patch`, or `prerelease` selects the revision.
- `--preid beta` selects a prerelease identifier.
- `--set 2.0.0` packages an exact new version.
- `bump <app> 2.0.0` changes only the config version.

When packaging and bumping together, the new version is written to the app config only after the staged package and app-specific verifier pass. A failed build leaves the previous package and source version in place.

## Root configuration

[`arcane-packager.json`](../arcane-packager.json) fixes the source and destination roots and defines named shared payloads. Each shared payload contains one or more explicit routes:

```json
{
  "schemaVersion": 1,
  "appsRoot": "apps",
  "distRoot": "dist",
  "sharedPayloads": {
    "browser-runtime": [
      {
        "source": "arcane",
        "destination": "arcane",
        "include": ["components", "css", "entities", "img", "modules"],
        "exclude": []
      }
    ]
  }
}
```

Routes are allowlist-first. `source` and `destination` are workspace-relative roots; `include` and `exclude` are literal paths relative to that source. A directory includes or excludes all descendants. Globs and arbitrary output paths are intentionally unsupported.

## App configuration

Every publishable app owns `apps/<id>/arcane-package.json`:

```json
{
  "schemaVersion": 1,
  "id": "example",
  "displayName": "Example App",
  "version": "0.1.0",
  "entry": "index.html",
  "strategy": "static",
  "include": ["index.html", "components", "img", "modules"],
  "exclude": ["img/source-material", "test"],
  "shared": ["browser-runtime"]
}
```

The ID must match the immediate `apps/<id>` directory. The entry must be a regular included file. `static` copies only the configured base payload. `adapter` invokes a trusted app-local `scripts/*.mjs` module for content-aware generation and verification; it still receives the same configured static base.

BOSS uses an adapter because publication requires per-record authorization, Markdown regeneration, original-document hashing, and private-token leak detection. Its adapter cannot be replaced with an exclude-only copy without weakening the release boundary.

## Verification and boundaries

The packager rejects unsafe relative paths, absolute paths, backslashes, traversal, overlapping includes, case-insensitive destination collisions, missing files, symlinks and junctions, and non-file entries. Repository metadata, `.env` files, `local`, and nested app `node_modules` are never published. Shared dependencies must be explicitly routed; the whole root `node_modules` directory cannot be selected.

The staged package receives `ARCANE_APP_RELEASE.json`, containing app identity, semantic version, entry point, a digest of the effective include/exclude/shared/adapter policy, byte counts, and a sorted SHA-256 inventory. Verification fails if packaging policy drifts or a file is modified, added, deleted, linked, or replaced by a special filesystem entry. Only a verified stage replaces `dist/<app>`.

The importable implementation is [`tools/app-packager/core.mjs`](../tools/app-packager/core.mjs). A future native Arcane administration UI can call this library through narrowly scoped host operations such as package list, build, and check. Browser pages and DBOPFS do not have authority to enumerate repository sources or write `dist/`, so packaging is not exposed as an unbounded browser filesystem or process API.
