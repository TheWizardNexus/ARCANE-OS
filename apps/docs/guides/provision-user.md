# Provision your first Arcane OS user

Choose the walkthrough for the operating system that authenticates the user.

## Microsoft NT

Arcane OS 0.8.4 supports the complete first-user journey on Microsoft NT: an administrator stages a standard local account, saves its temporary credential, chooses **Activate this account** in a separate request, and then the user signs in through Microsoft NT. Arcane Shell starts as that account's shell; there is no separate Arcane sign-in form.

[Open the Microsoft NT provisioning and sign-in walkthrough](provision-user-windows.md)

## Linux

Arcane OS 0.8.4 has an experimental, unsigned-local Linux first-user journey for controlled testing. After building and verifying the release, an administrator launches the exact Provisioner from a separately authorized root session. Arcane can then stage a standard local account locked and expired, return its temporary credential for private delivery, assign the installed POSIX login-shell wrapper, and enable it only after a separate **Activate this account** request.

[Open the Linux provisioning and sign-in walkthrough](provision-user-linux.md)

## Open the Shell without changing sessions

Arcane Shell can also open directly inside an existing Microsoft NT or Linux desktop session for development, demonstrations, and screenshots. No host logout or login is required for that direct launch. The Shell does not authenticate a separate Arcane identity: `Arcane.user.current()` reports the current host operating-system account.

On Microsoft NT, after creating a development-signed build, run this from the repository root:

```powershell
.\machine_bundles\arcane-os-machine-bundle-v0.8.4\start-shell.bat
```

On Linux, build the machine bundle and run `./start-shell.sh` from its directory. Wait for the identity, operating-system, host, and application states to finish loading before capturing the screen. Close the Shell window afterward; do not press **Log out**, because that requests an actual logout from the host operating system.

A direct launch is a valid Shell demonstration, but it does not replace each platform walkthrough's sign-out, first-login, mandatory-password-change, and automatic-Shell-assignment checks. On WSLg it remains the expected graphical launch path because WSL does not provide a Linux display manager.

> The public Docs app cannot create accounts and never asks for a username or password. Screenshots in these walkthroughs come from controlled simulations, contain no credentials, and do not establish real clean-host acceptance. Linux publisher signing, automatic privilege brokerage, and disposable-host login acceptance remain incomplete.
