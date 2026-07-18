# Provision an Arcane OS user

Arcane user provisioning is an administrator journey for the supported Microsoft NT host. It creates or converts a standard operating-system account, assigns the verified Arcane Shell, and preserves a recoverable record of the prior shell state.

> The public documentation site cannot create accounts and never asks for a username or password. Complete this journey only in the trusted native **Arcane Provisioner** on the target machine.

## Before you begin

- Use Microsoft NT for the current real-account workflow. Arcane OS 0.8.4 deliberately disables real account and login-shell provisioning on Linux.
- Start a verified Arcane Provisioner build. Review its publisher, release-integrity, installation, and operating-system status before changing the machine.
- Sign in as an authorized administrator, but do not provision the account currently running the Provisioner. Arcane protects that account from shell replacement.
- Make sure the required machine services are ready. In particular, provisioned users require the healthy machine-wide Arcane Ollama service; a user-only Ollama installation does not satisfy this requirement.
- Decide whether you are creating a missing standard account or converting an existing standard account. Existing account passwords and group memberships are preserved.

## Create and activate the account

1. Open **Arcane Provisioner** and refresh the machine and user status.
2. Complete the Arcane machine installation first if the verified baseline is not ready.
3. In **Create Arcane users**, enter the intended account name and review validation before continuing.
4. Choose **Create Arcane user**. For a missing account, Arcane creates a disabled standard account, records its exact Microsoft NT security identifier, captures the previous shell state, assigns Arcane Shell, and returns a temporary password. The account remains disabled and marked `activation-pending`.
5. Save the temporary password somewhere controlled by the intended user. It exists only in the running Provisioner session. Do not paste it into this documentation site, a chat, an issue, or source control.
6. After confirming the credential is saved, choose **Activate this account** for that staged user. Activation is a separate privileged request; account creation never silently enables the account.
7. Sign out of the administrator session and let the new user sign in with the temporary password. Microsoft NT requires the password to be changed at first sign-in.
8. Confirm that the verified Arcane Shell opens and that the user can reach Settings, logout, and the documented recovery path.

## Existing accounts

When the account already exists, Arcane preserves its password and memberships while recording and replacing only its supported shell assignment. If the password is unknown, use **Set temporary password** only after the account is an active, verified Arcane user:

1. Choose **Set temporary password**. This first request only prepares and displays a credential; it does not change the operating-system password.
2. Save the displayed credential.
3. Choose **Apply saved password**. This separate request changes the password and requires a change at the next sign-in.

If the second request never occurs, the old password remains unchanged. If the request is interrupted after Microsoft NT accepts it, the operator already has the recovery credential.

## Recovery and rollback

- If activation fails, leave the account staged and retry **Activate this account**. Arcane reconciles an interrupted enable operation instead of guessing from the username.
- If a staged session no longer has the credential, issue a new temporary password before activation.
- Use **Restore previous shell** for an Arcane-managed account when the supported recovery decision is to return that user to its captured shell. Arcane verifies the restored state and refuses to overwrite a shell changed outside Arcane.
- A failure before credential delivery may roll back a newly created account only when its recorded security identifier still matches. An account whose identifier was not durably recorded remains disabled for administrator review rather than being deleted by name.
- For a pre-existing account, rollback is scoped to the shell assignment. It does not undo a separately requested password reset.

## Native API boundary

The Provisioner is authorized for the native calls shown below; ordinary web applications are not. Use these names to understand logs and implementation documentation, not as browser-console setup instructions.

```js
await Arcane.provisioning.plan(["arcane1"]);
await Arcane.users.add(["arcane1"]);       // prepares a disabled staged account
await Arcane.users.activate("arcane1");    // explicit second step
await Arcane.users.restoreShell("arcane1");
```

## Source of truth

This journey is summarized from the machine bundle's **Provisioning behavior** contract and the application-facing Arcane API reference. Release-specific warnings in the running Provisioner take precedence over this overview.
