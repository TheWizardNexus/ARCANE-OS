# Provision and sign in your first Arcane OS user on Microsoft NT

Arcane OS 0.8.4 supports the complete Microsoft NT first-user journey. An authorized administrator uses the trusted native **Arcane Provisioner**; the new user later authenticates through Microsoft NT and enters Arcane Shell without a second Arcane login.

> The screenshots below are controlled Microsoft NT simulations. They show the current labels and state transitions, but no real account was changed, no credential is visible, and the images do not establish clean-host acceptance. Never put a temporary password in a screenshot, operation log, chat, issue, source file, or automated clipboard stream.

## Before you begin

- Use a publisher-signed or development-signed external Arcane Provisioner that you trust. Confirm the displayed version, publisher or local-development trust, release integrity, and target installation path before continuing.
- Sign in as an authorized administrator. Provision a different account: Arcane protects the account currently running the Provisioner from shell replacement.
- Complete the Provisioner's requirement checks. The installed Arcane payload, native renderer, session control, and machine-wide Arcane Ollama service must be ready.
- Choose a standard, non-administrator local account name. Arcane can create a missing account or convert an existing standard account.

## Stage the account

1. Open **Arcane Provisioner** and review the release-trust, operating-system, installation, and requirement status.
2. If necessary, use the Provisioner's install, update, or repair action before adding a user. Approve a Microsoft NT elevation prompt only when its application, publisher, action, and target match what the Provisioner just described.
3. In **Add Arcane users**, enter the intended username. Read the validation and protected-account message, then choose **Add Arcane user**.

![Controlled Microsoft NT simulation of Add Arcane users with a validated example username and the Add Arcane user button.](../../../../../screenshots/windows-add-arcane-user.jpg)

For a missing username, Arcane creates a disabled standard local account, prepares its profile, assigns the verified Arcane Shell, requires a password change at first sign-in, and returns a temporary password. The account remains disabled and marked as awaiting activation. Creating the account does not silently activate it.

## Save the credential, then activate

4. Save the temporary password privately for the intended user. It exists only in the running Provisioner session. Do not continue until the credential has been saved through an approved private path.
5. Confirm that the user card says the setup is not finished and the account is awaiting activation.

![Controlled Microsoft NT simulation of a staged disabled account awaiting activation; no temporary password is shown.](../../../../../screenshots/windows-account-awaiting-activation.jpg)

6. Choose **Activate this account** on that user card. Activation is a separate privileged request and may cause a separate Microsoft NT elevation prompt.
7. Confirm that the same account is now marked **Arcane Shell assigned** and **Enabled**.

![Controlled Microsoft NT simulation after activation, showing the account as Arcane Shell assigned and enabled.](../../../../../screenshots/windows-account-activated.jpg)

## First sign-in

8. Sign out of the administrator session. At the Microsoft NT sign-in screen, choose the new local account and enter the temporary password privately.
9. Change the password when Microsoft NT requires it. Do not automate, record, or screenshot the password-entry or password-change screens.
10. After Microsoft NT accepts the sign-in, the verified Arcane Shell starts as the user's shell. There is no Arcane username or password form. Confirm the release identity, open Settings, and verify that logout and the documented recovery path are reachable.

![Controlled Microsoft NT simulation of Arcane Shell after launch, showing the release, signed-in operating-system user, and Settings entry point.](../../../../../screenshots/windows-arcane-shell.jpg)

## Existing accounts and password recovery

Adding an existing standard account preserves its current password and group memberships while assigning the supported Arcane shell bindings. If an active Arcane user's password is unknown:

1. Choose **Prepare temporary password**. This prepares and displays a credential for private review; it does not change the Microsoft NT password.
2. Save the credential privately.
3. Choose **I saved this — apply password**. Only this separate privileged request changes the Microsoft NT password and requires a change at next sign-in.

If the apply request never happens, the old password remains unchanged. If activation fails, leave the staged account disabled and retry **Activate this account**. If the staged credential was not saved, choose **Issue new temporary password** before activation rather than exposing or guessing the original.

[Return to the platform chooser](provision-user.md)
