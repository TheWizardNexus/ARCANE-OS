### ASS-U-ME debugging record

**Reported behavior**
- Conditions/action: Linux Arcane OS 0.8.4, `installation.ensure`, observed in the connected Arcane OS Provisioner after the installation step.
- Observed result: HTTP 409 / `LINUX_PROTECTED_FILE_UNSAFE` at 2026-07-21T12:53:51.389Z.
- Technical message: `Arcane refused to use an unprotected Linux chmod account tool.`
- Reported path: `/usr/lib/cargo/bin/coreutils/chmod`.
- Diagnostic ID: `b08c62f6-a86f-4ad8-af0f-52f7d6c36dee`.
- Request ID: `ce1eac5d-c409-470e-a887-34f0d55f7e43`.
- Verified expectation: Arcane should not invoke a PATH-selected external process merely to change modes on its own already-validated state files. When an external privileged tool is required, it must execute only a protected canonical candidate.

**Reproduce**
- Live result: the connected Ubuntu Provisioner displayed “Unable to install Arcane OS” and the same unprotected Linux `chmod` diagnostic before any local Arcane users appeared.
- Synthetic result: `.tmp/arcane-linux-chmod-debug/reproduce.mjs` recreated the exact `LINUX_PROTECTED_FILE_UNSAFE` code and `/usr/lib/cargo/bin/coreutils/chmod` rejected path with an unsafe first candidate and independently safe `/usr/bin/chmod` candidate.

**Preserve**
- User-provided diagnostic remains in the task history; identifiers and exact error identity are copied above.

**Inspect**
- `systemCommand()` returns the first merely existing candidate; `requiredAccountCommand()` validates only that candidate and never considers later candidates.
- `applyStatePermissions()` resolves and spawns external `chmod` even though the already-root process can use `fsp.chmod()` directly.
- `applyInstallPermissions()` earlier runs bare PATH-selected `chown -R` and `chmod -R` as root, before the later protected check. This violates the documented privileged-executable boundary.
- The live diagnostic proves the Cargo target failed at least one protected-file invariant, but it does not reveal the original candidate, the exact failed predicate, or whether a safe later host candidate exists.

**Isolate**
- Boundary: Linux native adapter state-permission application and privileged executable selection.
- One variable tested: with the filesystem and candidate ordering fixed, only the permission mechanism changed from external `chmod` to `fsp.chmod()`.
- Result: current code rejected the Cargo target and never inspected the safe later candidate; the manual correction completed both mode changes without resolving or spawning any executable.

**Manual correction**
- One change: a disposable in-memory source copy replaced the two external `chmod` calls in `applyStatePermissions()` with numeric `fsp.chmod()` calls.
- Manual verification result: mode calls were exactly state root `0755` and `users.json` `0600`; zero external commands and zero tool realpaths occurred.
- Classification: code defect plus privileged-boundary security defect; do not modify the host Cargo tool based on the incomplete diagnostic.

**Implementation**
- Root cause: the native adapter asked the root process to execute an externally selected `chmod` for state files it already owned; executable discovery stopped at the first existing candidate, and install permission setup also used bare PATH-selected recursive tools before later protection checks.
- Code fix: state modes now use validated, no-follow file handles and recheck identity and protected ancestry; root external commands are selected only from fixed system directories, canonicalized, validated with their directory chains, and allowed to fall through to an independently protected later candidate. The bare recursive `chown -R`/`chmod -R` calls were removed. Executable hard links are allowed when ownership/mode/ancestry are protected, while single-link checks remain for mutable state and account data. Linux staged-directory identity is now captured and required after activation rename.
- Rebuild/current artifact proof: `tools/build-core.mjs` regenerated `runtime/arcane-core.cjs` and `dist/app`; the generated core compared byte-for-byte with a fresh generator run, and `tools/verify.mjs` plus `tools/verify-development-api-source.mjs` passed.

**Clean-state retest**
- Original reproduction after fix: the disposable reproduction now completes the same state-mode operation with zero external commands; the connected host cannot yet repeat the original journey because it is still running the previously installed build.
- Focused regression check: the protected-executable/state-permission security suite passed all 6 cases, including unsafe-candidate fallback, writable-ancestry rejection, no-follow state handles, hard-link rejection for state files, identity-swap rejection, and absence of recursive install chmod/chown.
- Broader checks: the package-listed Node tests completed with 107 total, 103 passed, 4 real-Linux-root-only cases skipped on Windows, and 0 failed. Capability policy, user transaction, installation postcondition, release integrity, and framed RPC smoke tests all passed with no skips.
- Remaining uncertainty: a clean real-root Linux rebuild/deploy/restart and repetition of the original Provisioner journey remains required. The diagnostic does not establish which protection predicate the old Cargo `chmod` failed, so no host tool ownership or mode change is justified from that message alone.
