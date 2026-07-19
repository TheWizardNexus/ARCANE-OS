# Arcane OS Developer Command Reference

This is the authoritative table of supported system-level commands used to set up, develop, test, package, build, sign, and verify Arcane OS. Run root commands from the repository root unless a row says otherwise.

## Setup and routine verification

| Command | Purpose | Result / output | Use |
|---|---|---|---|
| `.\setup-developer.bat` | Performs the complete Windows developer bootstrap: prerequisites, public-registry verification, dependency installs, hooks, checks, development signing, and development build. | Development-signed Windows distribution. | Normal first-time setup. |
| `.\setup-developer.bat -SkipPrerequisiteInstall` | Runs setup without using WinGet. | Same as setup when prerequisites already exist. | Managed machines or reruns. |
| `.\setup-developer.bat -SkipChecks` | Skips the repository check gate during setup. | Setup and build without the full check. | Intentional reruns only. |
| `.\setup-developer.bat -SkipSigning` | Does not create or use a development certificate. | Explicitly labeled unsigned-local-test build. | Local verification only. |
| `.\setup-developer.bat -SkipBuild` | Installs and verifies the development environment without building. | Ready development checkout. | Environment preparation only. |
| `npm run setup:developer` | PowerShell form of the unified setup after Node/npm exists. | Same default result as `setup-developer.bat`. | npm-driven setup. |
| `npm ci` | Installs the exact root dependency lock. | Root `node_modules`. | Clean installs; do not substitute `npm install`. |
| `npm run hooks:install` | Installs the repository Git hooks. | Configured pre-push hook. | Hook repair or manual setup. |
| `npm run prepare` | npm lifecycle alias that installs the repository Git hooks. | Configured pre-push hook. | Runs automatically after supported dependency installs; manual use is rarely needed. |
| `npm run verify:package-locks` | Rejects dependency URLs outside approved public npm registries. | Pass/fail registry report. | Before and after lockfile changes. |
| `npm test` | Runs the root JavaScript contract suite. | Node test report. | Routine focused verification. |
| `npm run test:redress` | Runs the Redress application suite. | Node test report. | Redress changes. |
| `npm run test:machine` | Runs the portable machine-bundle check. | Core, bridge, security, packaging, and portable-app checks. | Machine/runtime changes. |
| `npm run check` | Runs lockfile, root, Redress, public-app, and machine checks. | Complete platform-neutral repository gate. | Before handoff. |
| `npm run check:windows` | Runs the Windows machine-bundle gate. | Windows smoke, unsigned build, and verification results. | Windows/release-path changes. |
| `npm run prepush` | Runs the fast root pre-push test gate. | Root test report. | Normally invoked by Git. |
| `npm run release:check` | Runs the complete repository and Windows release checks. | Full release-readiness report. | Explicit release preparation. |

## Application packaging

| Command | Purpose | Result / output |
|---|---|---|
| `npm run apps:list` | Lists registered applications and versions. | Stable app inventory. |
| `npm run app:inspect -- <app-id>` | Shows one app's package definition without building it. | Inspection record. |
| `npm run app:package -- <app-id>` | Creates one static/adapter application package. | App package under its configured distribution path. |
| `npm run app:release -- <app-id>` | Performs the app release workflow. | Verified versioned app release. |
| `npm run app:check -- <app-id>` | Verifies an existing app package. | Package-policy and integrity result. |
| `npm run app:bump -- <app-id> <major\|minor\|patch\|prerelease>` | Changes an app's SemVer through the packager. | Updated app version after successful validation. |
| `npm run test:app-packager` | Runs focused app-packager tests. | Node test report. |
| `npm run build:boss-public` | Builds the public BOSS package. | Public BOSS distribution. |
| `npm run lock:boss-public` | Refreshes only the BOSS public-release lock. | Updated public-release lock. |
| `npm run test:boss-public` | Tests the BOSS public-release contract. | Node test report. |
| `npm run check:boss-public` | Tests and verifies the BOSS public package. | Complete BOSS public-package result. |
| `npm run check:public-apps` | Tests BOSS and verifies all public app packages. | Public application verification result. |
| `npm run model:ensure` | Ensures the configured Arcane Ollama model exists. | Existing or newly created local model. |

## Windows development and signing

| Command | Purpose | Signing requirement | Result / output |
|---|---|---|---|
| `npm run signing:bootstrap:dev:windows` | Creates/reuses and trusts the current user's non-exportable Arcane development certificate. Windows may request one-time confirmation before trusting the self-signed certificate. | None; creates development identity only. | Current-user development certificate and trust. |
| `npm run build:dev:windows` | Builds the complete Windows distribution with the development certificate. | Development bootstrap. | Development-signed `dist/windows`. |
| `npm run build:dev:apps:windows` | Builds all Windows apps with the development certificate. | Development bootstrap. | Development-signed app executables. |
| `npm run build:dev:app:windows -- -AppId <app-id>` | Builds one Windows app with the development certificate. | Development bootstrap. | One development-signed app executable. |
| `npm run signing:preflight:windows` | Validates authorized production certificate, publisher, timestamp, and signing tools without building. | Production signing material. | Production signing readiness result. |
| `npm run build:signed:windows` | Builds the complete production Windows distribution. | `ARCANE_SIGNING_CERT_THUMBPRINT`, matching publisher trust anchor, and timestamp server. | Production-signed distribution. |
| `npm run build:signed:apps:windows` | Builds all production-signed Windows apps. | Production signing material. | Production-signed app executables. |
| `npm run build:signed:app:windows -- -AppId <app-id>` | Builds one production-signed Windows app. | Production signing material. | One production-signed app executable. |

Development setup never creates, reads, or persists production signing material. The production commands must fail closed when authorized production identity is absent.

## Machine-bundle commands

Run these from `machine_bundles/arcane-os-machine-bundle-v0.8.4`, or add `npm --prefix machine_bundles/arcane-os-machine-bundle-v0.8.4 run` before the script name.

| Script | Purpose | Result / output |
|---|---|---|
| `generate:method-policies` | Generates host method-policy artifacts from the canonical application and capability manifests. | Synchronized Core and Android policy sources. |
| `build` | Generates the core runtime from its canonical template. | `runtime/arcane-core.cjs`. |
| `verify` | Verifies runtime, API source, directory selection, and Windows-host source contracts. | Verification report. |
| `smoke` | Runs bridge, API, security, provisioning, installation, and isolation smoke tests. | Smoke-test report. |
| `test:app-packager` | Tests machine app catalog and packager behavior. | Node test report. |
| `test:content-binding` | Tests release bindings, signing, recovery, and worker claims. | Node test report. |
| `check` | Runs portable build, verification, smoke tests, packager tests, and portable app builds. | Complete portable machine gate. |
| `check:windows` | Runs Windows tests, an unsigned-local-test distribution build, and final verification. | Complete Windows machine gate. |
| `prepush` | Runs both machine `check` gates. | Full machine pre-push report. |
| `dev:provisioner` | Serves the provisioner with the development HTTP bridge. | Local provisioner development host. |
| `dev:shell` | Serves the shell with the development HTTP bridge. | Local shell development host. |
| `build:app -- <app-id>` | Builds one portable native-capable app. | Portable app package. |
| `build:app:windows -- <app-id>` | Builds one Windows app under normal signed-release policy. | Windows app executable. |
| `build:app:windows:unsigned-local-test -- <app-id>` | Builds one explicitly unsigned local-test Windows app. | Labeled unsigned test executable. |
| `build:apps:portable` | Builds every registered portable app. | Portable app packages. |
| `build:apps` | Alias of `build:apps:portable`. | Portable app packages. |
| `build:apps:windows` | Builds every Windows app under normal signed-release policy. | Windows app executables. |
| `build:apps:windows:unsigned-local-test` | Builds all explicitly unsigned local-test Windows apps. | Labeled unsigned test executables. |
| `build:distribution:windows` | Builds a production-policy Windows distribution. | Requires production signing environment downstream. |
| `build:win` | Alias of `build:distribution:windows`. | Production-policy Windows distribution. |
| `build:distribution:windows:unsigned-local-test` | Builds the explicitly labeled unsigned Windows distribution. | Local-test `dist/windows`. |
| `build:windows:iteration` | Rebuilds the Windows iteration distribution without production signing. | Iteration distribution. |
| `build:windows:iteration:fast` | Runs the narrow fast Windows iteration path. | Fast iteration output. |
| `build:core:win` | Packages the generated Node core as a Windows executable. | `dist/ArcaneCore.exe`. |
| `build:core:linux` | Packages the generated Node core as a Linux executable. | `dist/ArcaneCore`. |
| `build:linux` | Builds the Linux core and WebKitGTK host. | Linux distribution artifacts. |
| `verify:apps` | Verifies built application packages. | App verification result. |
| `verify:app-catalog` | Verifies the generated application catalog. | Catalog verification result. |
| `verify:distribution:windows` | Verifies a signed Windows distribution and its security binding. | Signed-release verification result. |
| `verify:distribution:windows:unsigned-local-test` | Verifies the unsigned-local-test distribution and binding. | Local-test verification result. |
| `verify:winhost` | Verifies Windows host, DPI, iteration, and Ollama service source contracts. | Windows host source report. |
| `verify:windispatch` | Verifies native Windows host dispatch against built binaries. | Dispatch verification result. |
| `verify:winsecurity` | Verifies signatures and release binding for signed output. | Signed security result. |
| `verify:winsecurity:unsigned-local-test` | Verifies binding without requiring signatures. | Unsigned local-test security result. |
| `smoke:windows:release-directory-locks` | Tests recovery from locked Windows release directories. | PowerShell smoke result. |
| `smoke:windows:installed-apps` | Tests behavior against installed Windows apps. | Node smoke result. |

## Native launchers

| Command | Purpose |
|---|---|
| `build-windows.bat` | Legacy/direct Windows production-policy bundle build; ordinary developers should use the root unified setup or development build instead. |
| `build-linux.sh` | Builds the Linux bundle. |
| `start-provisioner.bat` / `start-provisioner.sh` | Starts the native provisioner. |
| `start-shell.bat` / `start-shell.sh` | Opens the native Arcane Shell inside the current Microsoft NT or Linux desktop session for development, demonstrations, and screenshots; no host logout or login is required. |
| `start-provisioner-debug.bat` | Starts the Windows provisioner with debugging enabled. |

## Maintenance rule

Follow [Developer Reference Maintenance SOP](developer-reference-sop.md). Every new or changed public system tool, launcher, root npm command, or machine-bundle npm command must update this table in the same change.
