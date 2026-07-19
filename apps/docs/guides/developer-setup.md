# Set up an Arcane OS development checkout

Arcane OS development uses a normal Git checkout, locked public dependencies, the shared browser runtime, focused Node.js tests, and platform-specific build gates. Microsoft NT is the supported real-account and first-release native host. Linux is an experimental native developer host with GTK 4 and WebKitGTK 6.0 Provisioner and Shell binaries.

## Fast path on Microsoft NT

1. Install Git and clone the repository.

   ```powershell
   git clone git@github.com:TheWizardNexus/ARCANE-OS.git
   cd ARCANE-OS
   ```

2. Run the unified developer bootstrap from the repository root.

   ```powershell
   .\setup-developer.bat
   ```

   The bootstrap checks prerequisites, verifies dependency registries, installs locked dependencies and Git hooks, runs the repository gates, creates or reuses the current developer's non-exportable local signing identity, and builds a development-signed Microsoft NT distribution.

3. If prerequisites are centrally managed, use the documented setup switches instead of editing the script. For example:

   ```powershell
   .\setup-developer.bat -SkipPrerequisiteInstall
   ```

4. Open the development-signed Provisioner with `.\machine_bundles\arcane-os-machine-bundle-v0.8.4\start-provisioner.bat`. The binary is under `machine_bundles\arcane-os-machine-bundle-v0.8.4\dist\windows\bin\ArcaneProvisioner.exe`. Local development trust belongs only to the Windows user who created it and is never a production signing claim.

5. To open the native Shell inside the current Microsoft NT desktop session, without signing out or provisioning another account, run:

   ```powershell
   .\machine_bundles\arcane-os-machine-bundle-v0.8.4\start-shell.bat
   ```

   The direct Shell reports the current operating-system account. It is suitable for development and screenshots, but it is not first-login acceptance evidence for a provisioned Arcane user. Close the Shell window when finished; its **Log out** action ends the current host operating-system session.

## Fast path on Linux

Install Node.js 22 or newer plus the GTK/WebKitGTK build prerequisites, verify the public dependency sources, and build the machine bundle:

```bash
sudo apt install build-essential libgtk-4-dev libwebkitgtk-6.0-dev
npm run verify:package-locks
npm ci
npm run hooks:install
cd machine_bundles/arcane-os-machine-bundle-v0.8.4
./build-linux.sh
./start-shell.sh
```

No host logout or login is required for this direct Shell launch. Linux real-account provisioning, login-shell replacement, installed-application launch, automatic privilege brokering, signed distribution acceptance, and native CI remain incomplete. Read the dedicated [Linux developer host guide](./linux-host.md) for the exact capability boundary and capture guidance.

## Manual, browser-runtime-only setup

For documentation, shared JavaScript, and portable app work that does not need a native build:

```powershell
npm run verify:package-locks
npm ci
npm run hooks:install
npm test
```

Use Node.js 22 or newer. Keep `package-lock.json` authoritative and use `npm ci`; do not replace the public registry with an undeclared private or local dependency source.

## Build and test an application

Arcane apps are packaged from positive inventories. The docs site is an adapter package because its catalog is generated from a reviewed public-source allowlist.

```powershell
npm run app:inspect -- docs
npm run app:package -- docs
npm run app:check -- docs
```

The verified output is written under `dist/docs`. GitHub Pages deploys that output, not the repository root or the working `docs` directory.

Run the complete portable repository gate before requesting review:

```powershell
npm run check
```

The Microsoft NT compiled gate is separate:

```powershell
npm run check:windows
```

`npm run release:check` combines them, but passing it does not turn a local build into a release candidate or replace production signing and clean-machine acceptance.

## Create or change an app

Before implementation:

1. Read `docs/app-building.md` in full.
2. Search `arcane/`, existing apps, examples, and tests for reusable behavior.
3. Answer the four capability questions and keep general mechanisms in the appropriate shared `arcane/` layer.
4. Load `arcane/css/theme.css` and `arcane/modules/ThemeBootstrap.js`, then shared primitives, then app CSS.
5. Use Arcane theme tokens and `rgb(...)` or `rgba(...)` for any new color values.
6. Add the capability declaration, focused tests, example, packaging policy, and security or accessibility evidence required by the change.

When diagnosing a discrepancy, follow `docs/debugging.md`: reproduce, preserve evidence, inspect, isolate, manually fix, manually verify, fix the code, rebuild, and retest from a clean state.

## Work with the Developer app

Inside an installed Arcane environment, **Arcane Developer** can pair one explicitly selected checkout, inspect its supported setup state, and run one chosen setup task at a time. Its assistant uses the AI provider configured for the current Arcane user and sends only bounded, secret-pattern-redacted repository excerpts. It never scans for checkouts or executes AI suggestions.

The public GitHub Pages site has no native filesystem or command authority. Its search works against the published catalog; its optional assistant remains unavailable unless a compatible Arcane AI bridge is explicitly injected by a trusted host.
