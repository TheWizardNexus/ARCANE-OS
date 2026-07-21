# Provision your first Arcane OS user

Choose the walkthrough for the operating system that authenticates the user.

## Microsoft NT

Arcane OS 0.8.4 supports the complete first-user journey on Microsoft NT: an administrator stages a standard local account, saves its temporary credential, activates it in a separate request, and then the user signs in through Microsoft NT. Arcane Shell starts as that account's shell; there is no separate Arcane sign-in form.

[Open the Microsoft NT provisioning and sign-in walkthrough](provision-user-windows.md)

## Linux

Arcane OS 0.8.4 has an experimental, unsigned-local Linux first-user journey for controlled testing. After building and verifying the release, an administrator launches the exact Provisioner from a separately authorized root session. Arcane can then stage a standard local account locked and expired, return its temporary credential for private delivery, assign the installed POSIX login-shell wrapper, and activate the account only in a separate request.

[Open the Linux provisioning and sign-in walkthrough](provision-user-linux.md)

> The public Docs app cannot create accounts and never asks for a username or password. Screenshots in these walkthroughs come from controlled simulations, contain no credentials, and do not establish real clean-host acceptance. Linux publisher signing, automatic privilege brokerage, and disposable-host login acceptance remain incomplete.
