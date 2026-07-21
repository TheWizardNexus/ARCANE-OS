# Provision and sign in your first Arcane OS user on Linux

Arcane OS 0.8.4 can provision a standard local Linux account from an already-root Provisioner, but this is an experimental unsigned-local workflow for controlled testing. Linux publisher signing and kernel-verified automatic privilege brokerage are not implemented. Arcane never invokes `sudo` or PolicyKit for you, and this walkthrough does not claim real clean-host create, activate, PAM, display-manager, SSH, WSLg, or recovery acceptance.

> Every image below is a controlled Linux simulation. The images show the current labels and state transitions, change no real account, contain no credential, and are not native-host acceptance evidence. Never put a temporary password in a screenshot, operation log, chat, issue, source file, or automated clipboard stream.

## Build and verify the unsigned-local release

Use Node.js 22 or newer. From `machine_bundles/arcane-os-machine-bundle-v0.8.4` on Debian or Ubuntu, install the native build dependencies:

```bash
sudo apt install build-essential libgtk-4-dev libwebkitgtk-6.0-dev
```

Install a machine-wide Ollama service separately if local AI is required. Arcane does not run a Linux package manager or remote installer at runtime.

Build and then verify the exact unsigned-local distribution:

```bash
npm run build:distribution:linux:unsigned-local-test
npm run verify:distribution:linux:unsigned-local-test
```

The output is inventory-verified under `dist/linux/`, but it is not publisher-signed and must not be distributed as a production release. The native host accepts this flavor only with the exact `--allow-unsigned-local-release` launch flag.

## Launch the Provisioner with separate root authorization

A regular-user launch is useful for inspecting the interface and machine status:

```bash
./start-provisioner.sh --allow-unsigned-local-release
```

It cannot change an installation, account, password, or login shell. Close it, establish a root graphical session using your distribution's approved administrator procedure, and launch the same verified Provisioner from that separately authorized root session:

```bash
cd /absolute/path/to/machine_bundles/arcane-os-machine-bundle-v0.8.4
./start-provisioner.sh --allow-unsigned-local-release
```

The way a root process is authorized to connect to a graphical session is distribution-specific. Do not weaken display-server access controls or bypass the release-verification step merely to make the window open. In the Provisioner, confirm that the displayed release is the unsigned-local build you just verified and that permission status reports root scope before approving a machine change.

If Arcane is not installed, review and approve the separate installation confirmation. On native Linux, a fresh installation registers an **Arcane OS** X11 display-manager session and sets the next-boot systemd default to `graphical.target` only after its prerequisites verify. It does not switch the current session live. Under WSLg, installation does not register a display-manager session or change the boot target.

## Choose a standard local account

Arcane accepts a bounded local username and refuses protected identities. Choose a standard, non-root, non-service account that is not the account running the Provisioner and is not in an administrator group. A missing account can be created. An existing account must already be an active standard local account; a locked or expired existing account is rejected until an administrator resolves that state outside this transaction.

In **Add Arcane users**, enter the intended username and choose **Add Arcane user**.

![Controlled Linux simulation of Add Arcane users with a validated example username and the Add Arcane user button.](../../../../../screenshots/linux-add-arcane-user.png)

For a missing username, Arcane creates the standard local account with its login locked and its account expiry set in the past, records the exact UID and recovery state, sets a temporary password that must change at first sign-in, and assigns the verified Arcane POSIX login-shell wrapper. The account stays locked and expired while the credential is delivered. Creating it does not silently activate it.

## Save the credential, then activate

1. Save the temporary password through an approved private path for the intended user. Arcane keeps it only in the running Provisioner session. Do not put it in operation output, diagnostics, screenshots, tickets, or automated clipboard history.
2. Confirm that the account card says **Account setup is not finished**, **Staged disabled**, and **Awaiting activation**.

![Controlled Linux simulation of a staged locked and expired account awaiting activation; no temporary password is shown.](../../../../../screenshots/linux-account-awaiting-activation.png)

3. Only after the credential is saved, choose **Activate this account**. Activation is a separate root-authorized request. It rechecks the recorded UID and assigned shell, removes expiry while retaining the locked precondition, and unlocks the account only after those checks succeed.
4. Confirm that the same account is marked **Arcane shell assigned** and **Enabled**.

![Controlled Linux simulation after the separate activation request, showing the account as Arcane shell assigned and enabled.](../../../../../screenshots/linux-account-activated.png)

If the Provisioner session no longer has the staged credential, choose **Issue new temporary password** before activation. If activation fails, Arcane attempts to return the account to its locked and expired state; review the diagnostic and verify the account manually before retrying.

## First sign-in on native Linux

1. Sign out of the root or administrator session.
2. At the distribution's display manager, choose the new account and select the **Arcane OS** X11 session. Arcane does not register a Wayland session because Arcane Shell is a client, not a compositor.
3. Enter the temporary password privately and complete the PAM password change when Linux requires it. Do not automate, record, or screenshot either password screen.
4. After Linux authenticates the account, Arcane Shell opens in that user's session. There is no Arcane username or password form.

![Controlled Linux simulation of Arcane Shell after launch, showing the release and current operating-system user without credentials.](../../../../../screenshots/linux-arcane-shell.png)

The controlled Shell capture uses an empty verified application catalog, so **No apps** is expected in that image. It demonstrates the operating-system identity and Shell startup boundary, not a populated Linux application bundle.

The assigned login-shell wrapper deliberately behaves differently without a graphical display. On a console or SSH login it delegates to `/bin/bash` or `/bin/sh` with the original arguments, preserving a terminal and recovery path instead of trying to open the desktop. This fallback reduces lockout risk but is not a substitute for real remote-login acceptance testing.

## WSLg is a manual desktop launch

WSLg does not provide a Linux display manager. Arcane can perform the same standard-account transaction and POSIX shell verification from a separately authorized root Provisioner, but it records `manual-wslg`, does not register an Arcane login session, and does not change WSL's boot target. Authenticate or select the Linux account through the normal WSL distribution flow, then open Arcane Shell from that account's Ubuntu session:

```bash
./start-shell.sh
```

This is a manual WSLg desktop launch. It is not equivalent to selecting **Arcane OS** at a native display-manager sign-in.

## Existing accounts, password reset, and shell recovery

Adding an active existing standard account preserves its current password and group memberships while assigning the verified Arcane wrapper. Arcane does not learn that password and does not stage or reactivate the account. If a temporary password is needed later:

1. Choose **Prepare temporary password**. Arcane generates a credential for private review but does not change the operating-system password.
2. Save the credential privately.
3. Choose **I saved this — apply password**. Only this separate request changes the Linux password and marks it for change at next sign-in.

If the apply request never happens, the existing password remains unchanged.

Arcane records the prior POSIX login shell before assigning its wrapper. Use **Restore previous POSIX login shell** on the verified user card to stop using Arcane as that account's login shell. Restoration is root-authorized, is bound to the recorded UID, and refuses to overwrite a shell that another administrator changed after provisioning. If the recorded previous shell no longer exists, install it or select a recovery shell manually before removing Arcane.

[Return to the platform chooser](provision-user.md)
