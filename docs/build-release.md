# Arcane Build and Release Standard Operating Procedure

> **Mandatory use:** Follow this SOP before changing dependencies, lockfiles, build launchers, generated manifests, machine bundles, signing, packaging, continuous integration, or release automation.

## Required outcome

An Arcane build must be reproducible from a fresh checkout, use only approved public dependency sources, preserve canonical inputs on every supported operating system, stop at the first failed command, and keep local verification distinct from signed production publication.

## Procedure

### 1. Preserve and identify the build boundary

- Record the exact command, platform, Node/npm versions, signing mode, and first error.
- Preserve the relevant npm or build log before clearing caches or dependencies.
- Identify whether the failure occurs during dependency installation, source generation, compilation, signing, packaging, publication, or final verification.
- Follow `docs/debugging.md` for any failing or unexpected build.

### 2. Keep dependency resolution public and reproducible

- Commit every required lockfile and install with `npm ci`; do not substitute an unlocked install in verification or continuous integration.
- Every HTTP(S) `resolved` dependency in a committed npm lockfile must use an explicitly approved public registry. The current approved host is `registry.npmjs.org` over HTTPS.
- Never commit workstation, proxy, mirror, credentialed, private, OpenAI-internal, or organization-internal registry URLs.
- Run `npm run verify:package-locks` before installing dependencies and after regenerating any lockfile.
- Regenerate a contaminated lockfile against an approved registry, preserve integrity hashes, and verify it from an empty dependency directory and fresh npm cache.
- Do not commit npm caches, `node_modules`, credentials, tokens, certificates, or private registry configuration.

### 3. Preserve canonical files across platforms

- Any source file whose exact bytes are hashed, signed, embedded, or compared canonically must have an explicit `.gitattributes` rule.
- Machine-bundle `arcane-bundle.json` files must remain LF-only through `machine_bundles/*/arcane-bundle.json text eol=lf`.
- Windows batch launchers remain CRLF; shell scripts remain LF.
- Verify canonical content from a Windows checkout with `core.autocrlf=true`, not only from the Git blob or a Unix checkout.

### 4. Fail closed at every build step

- A launcher must stop after every nonzero subprocess exit code, including negative Windows status values.
- Do not use a positive-only `if errorlevel 1` check where a tool can return a negative status. Compare the captured status explicitly against zero.
- Never continue from a failed dependency install into compilation, signing, packaging, or publication.
- Do not suppress, overwrite, or reinterpret a failing exit code merely to complete a build.

### 5. Keep verification and publication modes separate

- Unsigned output is allowed only through the explicit unsigned-local-test command and must remain labeled and verified as such.
- Development-signed builds use the documented per-developer certificate bootstrap.
- Production builds must fail closed unless the required production signing identity and publisher continuity checks are present.
- Never weaken production signing requirements to make local verification pass.

### 6. Verify from a clean state

For dependency or cross-platform build changes, verify in this order:

1. `node tools/verify-package-lock-registries.mjs`
2. `npm ci` from an empty `node_modules` directory and fresh npm cache
3. the focused source or launcher contract check
4. the explicit unsigned-local platform build when production credentials are unavailable
5. final manifest, content-binding, executable-binding, and distribution verification
6. the normal CI or release gate from a fresh checkout

For the current Windows machine bundle, use:

```powershell
npm ci --prefix machine_bundles/arcane-os-machine-bundle-v0.8.4
npm run build:distribution:windows:unsigned-local-test --prefix machine_bundles/arcane-os-machine-bundle-v0.8.4
```

Use the signed production command only with authorized production signing material.

## Versioning a machine bundle

When adding a new `machine_bundles/<version>` directory:

- confirm the wildcard `.gitattributes` rules apply;
- include its lockfile in CI cache inputs when the CI job still names lockfiles explicitly;
- run the repository-wide package-lock registry verifier;
- run its clean dependency install and complete platform gate;
- update root scripts and documentation that intentionally select the current bundle version;
- verify no generated output, caches, secrets, or signing material are tracked.

## Required handoff

Report:

- dependency source and lockfile verification;
- canonical line-ending and byte-contract verification;
- launcher exit-code behavior;
- local, development-signed, or production signing mode used;
- exact clean-state build and verification commands;
- generated release location and final exit code;
- any production-only check not run and why.
