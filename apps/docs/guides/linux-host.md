# Run Arcane OS on a Linux developer host

Arcane OS 0.8.4 includes native GTK 4 and WebKitGTK 6.0 Provisioner and Shell hosts for Linux. Linux is currently an experimental developer host: it is useful for building, opening, inspecting, and capturing the native Shell, but it is not yet equivalent to the Microsoft NT real-account and release path.

## What works today

- The Linux bundle builds native `ArcaneProvisioner` and `ArcaneShell` applications.
- Arcane Shell can open inside an already-authenticated Linux desktop session.
- `Arcane.user.current()` reports the current Linux operating-system account as a `host-account`.
- The Shell can exercise the packaged browser runtime and the Linux platform adapter within its declared capabilities.

You do not need to log out of Linux and sign back in to open the Shell for development, demonstrations, or screenshots. A direct launch demonstrates the native Shell experience; it is not evidence of first-login account provisioning.

## Install the build prerequisites

Use Node.js 22 or newer. On Debian or Ubuntu, install the native compiler and host libraries:

```bash
sudo apt install build-essential libgtk-4-dev libwebkitgtk-6.0-dev
```

Optional native pickers use Zenity or KDialog when one is installed. Opening external URIs uses `xdg-open`, normally supplied by `xdg-utils`.

## Prepare and build the checkout

From the repository root, verify that the lockfiles use the declared public dependency sources before installing anything:

```bash
npm run verify:package-locks
npm ci
npm run hooks:install
```

Then build the Linux machine bundle:

```bash
cd machine_bundles/arcane-os-machine-bundle-v0.8.4
./build-linux.sh
```

The bundle build uses locked npm dependencies and compiles the native GTK/WebKitGTK host binaries. A successful local build is developer evidence only; native Linux CI, signed distribution acceptance, and Linux release-candidate gates are not complete.

## Open the native Shell

From the machine-bundle directory:

```bash
./start-shell.sh
```

If Arcane OS is already installed at the standard machine path, the equivalent direct command is:

```bash
/opt/arcane-os/bin/arcane-shell --shell
```

Wait until the Shell has resolved its identity, operating system, host, and application state before taking a screenshot. Use a public-safe username and hostname or crop those fields. Close the Shell window when finished. Do not choose **Log out** merely to exit a demonstration: that action requests a real logout of the current Linux desktop session.

## Open the Provisioner for inspection

```bash
./start-provisioner.sh
```

The Linux Provisioner can report the platform boundary and diagnostic state, but Arcane OS 0.8.4 deliberately fails closed for real Linux account creation, account activation, login-shell replacement, display-manager registration, and automatic privileged brokering.

## Current Linux limits

- Arcane OS does not yet provision Linux accounts; real Arcane user provisioning remains Microsoft NT-only.
- Installed-application listing and native launch are still gated to Microsoft NT.
- Ollama service installation and machine-service integration require manual Linux administration.
- A configured OpenAI token is written under `${XDG_CONFIG_HOME:-$HOME/.config}/arcane-os/credentials/openai.token`; creation requests mode `0600`, but Arcane OS 0.8.4 does not yet repair permissions on a pre-existing token file. Linux does not use the Microsoft NT DPAPI store.
- Linux local builds are not production-signed release candidates and do not replace clean-machine acceptance.

Use the Microsoft NT provisioning guide when validating real account activation, mandatory password change, automatic Shell assignment, recovery, and first sign-in.
