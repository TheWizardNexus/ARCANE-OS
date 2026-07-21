import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.dirname(toolsRoot);
const adapterPath = path.join(bundleRoot, 'src', 'native', 'linux.cjs');
const corePath = path.join(bundleRoot, 'src', 'core', 'arcane-core.template.cjs');
const adapterSource = await readFile(adapterPath, 'utf8');
const coreSource = await readFile(corePath, 'utf8');

function functionSource(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `Missing source boundary: ${start}`);
  assert.notEqual(to, -1, `Missing source boundary: ${end}`);
  return source.slice(from, to);
}

function ordered(source, fragments, message) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    assert.notEqual(next, -1, `${message}: missing ${fragment}`);
    assert(next > cursor, `${message}: ${fragment} is out of order`);
    cursor = next;
  }
}

function createAdapterHarness() {
  const writes = [];
  const sandbox = {
    Buffer,
    process: {
      arch: 'x64',
      platform: 'linux',
      execPath: '/release/ArcaneCore',
      env: {},
      getuid: () => 0,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${adapterSource}\nglobalThis.createAdapter = createLinuxNativeAdapter;`, sandbox, { filename: adapterPath });
  const ctx = {
    production: true,
    simulate: true,
    allowUnsignedLocalRelease: true,
    releaseSecurityModeClaim: 'unsigned-local-test',
    releaseContentBindingClaim: '',
    releaseSignerThumbprintClaim: '',
    releaseVerifiedAtClaim: '',
    releaseRevocationStatusClaim: '',
    releaseTrustSourceClaim: '',
    releaseTimestampVerifiedClaim: false,
    path: path.posix,
    crypto,
    fs: { existsSync: () => false },
    os: {
      homedir: () => '/home/operator',
      hostname: () => 'arcane-linux-test',
      release: () => '6.8.0-test',
      userInfo: () => ({ username: 'operator' }),
    },
    async writeFile(file, contents, mode) { writes.push({ file, contents, mode }); },
    arcaneError(code, message, resolution, status, details) {
      return Object.assign(new Error(message), { code, resolution, status, ...(details || {}) });
    },
  };
  return { adapter: sandbox.createAdapter(ctx), writes };
}

test('Linux username policy rejects injection shapes and protected service identities', () => {
  const { adapter } = createAdapterHarness();
  for (const username of ['arcane-user', '_arcane1', 'a', 'a'.repeat(32)]) {
    assert.equal(adapter.validateUsername(username), username);
  }
  for (const username of [
    '', 'has space', 'Uppercase', '-option', 'a.b', 'a:b', 'a/b', 'a\nname', 'a'.repeat(33),
    'root', 'daemon', 'bin', 'sys', 'www-data', '_apt', 'nobody',
  ]) {
    assert.throws(() => adapter.validateUsername(username), (error) => {
      assert(['INVALID_USERNAME', 'RESERVED_USERNAME'].includes(error.code), `${username}: ${error.code}`);
      return true;
    });
  }
});

test('installed Linux login-shell wrapper preserves no-display console and SSH operation', async () => {
  const { adapter, writes } = createAdapterHarness();
  assert.equal(adapter.supportsUserProvisioning, true);
  await adapter.writeLaunchers('/stage', {
    mode: 'linux-webkitgtk',
    securityMode: 'unsigned-local-test',
    integrity: { files: [] },
  });
  const launcher = writes.find(({ file }) => file === '/stage/bin/arcane-shell');
  const session = writes.find(({ file }) => file === '/stage/bin/arcane-session');
  assert(launcher, 'Arcane login-shell launcher was not generated');
  assert(session, 'Arcane display-manager session wrapper was not generated');
  assert.equal(launcher.mode, 0o755);
  assert.match(launcher.contents, /if \[ -n "\$\{DISPLAY:-\}" \] \|\| \[ -n "\$\{WAYLAND_DISPLAY:-\}" \]; then/);
  assert.match(launcher.contents, /exec "\$\(dirname "\$0"\)\/ArcaneShell" --allow-unsigned-local-release "\$@"/);
  ordered(launcher.contents, ['if [ -x /bin/bash ]', 'exec /bin/bash "$@"', 'exec /bin/sh "$@"'], 'console fallback');
  assert.doesNotMatch(launcher.contents, /\beval\b|\bsh\s+-c\b/);
  assert.match(session.contents, /exec "\$\(dirname "\$0"\)\/arcane-shell" --shell "\$@"/);
  assert.match(adapterSource, /payload\.integrity\.files = \[\.\.\.releaseIntegrityFiles, \.\.\.launcherIntegrityEntries\(payload\)\]/);
});

test('Linux account mutation source keeps identity, privilege, credential, and rollback controls ordered', () => {
  const standardAccount = functionSource(adapterSource, 'function assertStandardLocalAccount', 'function shadowRecord');
  assert.match(standardAccount, /expectedUid[\s\S]*?LINUX_ACCOUNT_IDENTITY_CHANGED/);
  assert.match(standardAccount, /duplicates\.length !== 1/);
  assert.match(standardAccount, /record\.uid < range\.minimum \|\| record\.uid > range\.maximum/);
  assert.match(standardAccount, /protectedMatch && !opts\.allowProtected/);
  assert.match(standardAccount, /adminGroups\.length && !opts\.allowPrivilegedGroups/);
  assert.match(standardAccount, /validateLocalHome\(record\)/);

  const shellRegistry = functionSource(adapterSource, 'async function ensureShellRegistered', 'function usernamePolicy');
  assert.match(shellRegistry, /O_NOFOLLOW/);
  assert.match(shellRegistry, /openedStat\.dev !== originalStat\.dev \|\| openedStat\.ino !== originalStat\.ino/);
  assert.match(shellRegistry, /openedStat\.nlink !== 1/);

  const provision = functionSource(adapterSource, 'async function provisionUser', 'async function activateProvisionedUser');
  ordered(provision, [
    'requireRootUserMutation();',
    'assertInstalledUserShell();',
    'await ensureShellRegistered(shell);',
    "requiredAccountCommand('useradd')",
    "requiredAccountCommand('chpasswd')",
    "requiredAccountCommand('usermod'), ['-L', username]",
    "requiredAccountCommand('chage'), ['-d', '0', username]",
    'const stagedState = shadowState(username);',
    "requiredAccountCommand('usermod'), ['-s', shell, username]",
  ], 'staged-account mutation');
  assert.match(provision, /\['-m', '-e', '1970-01-02', '-s', nologin, username\]/);
  assert.match(provision, /input: `\$\{username\}:\$\{password\}\\n`/);
  assert.match(provision, /suppressRawStdout: true,[\s\S]*?suppressRawStderr: true/);
  assert.match(provision, /if \(exists\)[\s\S]*?shadowState\(username\)[\s\S]*?if \(!status\.enabled\)/);

  const activate = functionSource(adapterSource, 'async function activateProvisionedUser', 'async function rollbackCreatedUser');
  ordered(activate, [
    'requireRootUserMutation();',
    'expectedUid: staged.uid',
    'if (!before.locked)',
    "requiredAccountCommand('usermod'), ['-U', username]",
    'expectedUid: staged.uid',
  ], 'activation identity binding');
  assert.doesNotMatch(activate, /if \(!before\.locked \|\| !before\.expired\)/,
    'an activation retry must reconcile a still-locked account if a prior attempt already cleared only its expiry');

  const rollback = functionSource(adapterSource, 'async function rollbackCreatedUser', 'async function resetUserPassword');
  ordered(rollback, [
    'if (initial.uid !== staged.uid)',
    "requiredAccountCommand('usermod'), ['-L', username]",
    "requiredAccountCommand('usermod'), ['-e', '1970-01-02', username]",
    "requiredAccountCommand('userdel'), ['-r', username]",
  ], 'exact-UID rollback');

  const restore = functionSource(adapterSource, 'async function restoreUserShell', 'function launchBrowser');
  assert.match(restore, /assertStandardLocalAccount\(username, \{ expectedUid, allowProtected: true, allowPrivilegedGroups: true \}\)/,
    'exact-UID recovery must remain available after an Arcane-managed account becomes protected or privileged');
  assert.match(restore, /if \(current\.shell !== assignedShell\)/,
    'recovery allowances must not permit overwriting a shell that no longer belongs to Arcane');
});

test('Core preserves the protected-account and exact-UID transaction boundary on Linux', () => {
  const validation = functionSource(coreSource, 'function validateProvisioningUsername', 'function validateUsernames');
  assert.match(validation, /protectedProvisioningUsernames\(\)/);
  assert.match(validation, /CURRENT_USER_PROTECTED/);

  const provisioning = functionSource(coreSource, 'async function provisionUsers', 'async function activateStagedArcaneUser');
  assert.match(provisioning, /passwordStatus = result\.created \? 'temporary-issued-disabled' : 'existing-password-unchanged'/);
  assert.match(provisioning, /if \(result\.created\) \{[\s\S]*?temporaryPassword: password,[\s\S]*?activationRequired: true/);
  assert.match(provisioning, /if \(item\.result\.created\)[\s\S]*?native\.rollbackCreatedUser/);
  assert.match(provisioning, /existing password unchanged/i);

  const activation = functionSource(coreSource, 'async function activateStagedArcaneUser', 'async function resetArcaneUserPassword');
  assert.match(activation, /record\.accountMutationPhase !== 'activation-pending'/);
  assert.match(activation, /uid: record\.uid/);
  assert.match(activation, /native\.activateProvisionedUser/);
});
