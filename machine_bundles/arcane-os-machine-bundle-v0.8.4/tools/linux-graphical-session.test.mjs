import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync, { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.dirname(toolsRoot);
const adapterPath = path.join(bundleRoot, 'src', 'native', 'linux.cjs');
const corePath = path.join(bundleRoot, 'src', 'core', 'arcane-core.template.cjs');
const bundlePath = path.join(bundleRoot, 'arcane-bundle.json');
const adapterSource = readFileSync(adapterPath, 'utf8');
const coreSource = readFileSync(corePath, 'utf8');
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
const policy = Object.freeze({ defaultTarget: 'graphical.target', sessionType: 'x11' });
const sessionEntry = `[Desktop Entry]
Type=Application
Name=Arcane OS
Comment=Start Arcane Shell as the authenticated Linux desktop session
Exec=/opt/arcane-os/bin/arcane-session
TryExec=/opt/arcane-os/bin/arcane-session
DesktopNames=Arcane;
`;

function coreFunctionSource(start, end) {
  const from = coreSource.indexOf(start);
  const to = coreSource.indexOf(end, from);
  assert.notEqual(from, -1, `Missing Core ${start}`);
  assert.notEqual(to, -1, `Missing Core boundary ${end}`);
  return coreSource.slice(from, to);
}

function createHarness(options = {}) {
  const calls = { run: [], boundedSpawnSync: [], logs: [], writes: [] };
  const defaultTargets = [...(options.defaultTargets || ['multi-user.target', 'graphical.target'])];
  const sandbox = {
    process: {
      arch: 'x64',
      platform: 'linux',
      env: {},
      getuid: () => options.uid ?? 0,
    },
  };
  vm.runInNewContext(`${adapterSource}\nglobalThis.createAdapter = createLinuxNativeAdapter;`, sandbox, { filename: adapterPath });
  let sessionEntryPresent = options.sessionExists !== false;
  const sessionLauncher = '/opt/arcane-os/bin/arcane-session';
  const sessionEntryPath = '/usr/share/xsessions/arcane-os.desktop';
  const sessionPaths = new Set([sessionLauncher, sessionEntryPath]);
  const protectedDirectoryInodes = new Map([
    ['/', 1],
    ['/usr', 2],
    ['/usr/bin', 3],
  ]);
  const ctx = {
    production: true,
    simulate: false,
    allowUnsignedLocalRelease: true,
    releaseSecurityModeClaim: 'unsigned-local-test',
    releaseContentBindingClaim: '',
    releaseSignerThumbprintClaim: '',
    releaseVerifiedAtClaim: '',
    releaseRevocationStatusClaim: '',
    releaseTrustSourceClaim: '',
    releaseTimestampVerifiedClaim: false,
    path: path.posix,
    fs: {
      existsSync(candidate) {
        if (candidate === '/usr/bin/systemctl') return options.systemctl !== false;
        if (candidate === sessionEntryPath) return sessionEntryPresent;
        return candidate === sessionLauncher;
      },
      readFileSync(candidate) {
        if (candidate === '/proc/sys/kernel/osrelease') return options.wsl ? '6.6.87.2-microsoft-standard-WSL2' : '6.8.0-generic';
        if (candidate === '/proc/version') return options.wsl ? 'Linux version microsoft WSL2' : 'Linux version 6.8.0';
        if (candidate === '/proc/1/comm') return `${options.initProcess || 'systemd'}\n`;
        if (candidate === sessionEntryPath && sessionEntryPresent) return options.sessionValid === false ? '[Desktop Entry]\nName=Other\n' : sessionEntry;
        if (candidate === sessionLauncher) return '#!/bin/sh\n';
        throw Object.assign(new Error(`Unexpected read: ${candidate}`), { code: 'ENOENT' });
      },
      realpathSync(candidate) {
        if (candidate === '/usr/bin/systemctl') return candidate;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      lstatSync(candidate) {
        if (protectedDirectoryInodes.has(candidate)) {
          return {
            uid: 0,
            mode: 0o40755,
            dev: 1,
            ino: protectedDirectoryInodes.get(candidate),
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => false,
          };
        }
        if (candidate === '/usr/bin/systemctl') {
          return {
            uid: 0,
            mode: 0o100755,
            nlink: 1,
            dev: 1,
            ino: 4,
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          };
        }
        if (!sessionPaths.has(candidate) || (candidate === sessionEntryPath && !sessionEntryPresent) || options.sessionValid === false) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return {
          uid: options.sessionUid ?? 0,
          mode: candidate.endsWith('.desktop')
            ? (options.desktopMode ?? options.sessionMode ?? 0o100644)
            : (options.launcherMode ?? options.sessionMode ?? 0o100755),
          isFile: () => true,
          isSymbolicLink: () => options.sessionSymlink === true,
        };
      },
    },
    os: {
      homedir: () => '/home/arcane',
      hostname: () => 'arcane-linux',
      release: () => options.wsl ? '6.6.87.2-microsoft-standard-WSL2' : '6.8.0-generic',
      userInfo: () => ({ username: 'root' }),
    },
    fsp: {
      async rm() {},
      async symlink() {},
      async copyFile() {},
    },
    async ensureDir() {},
    async writeFile(candidate, contents, mode) {
      calls.writes.push({ path: candidate, contents, mode });
      if (candidate === sessionEntryPath) sessionEntryPresent = true;
    },
    boundedSpawnSync(command, args, spawnOptions) {
      calls.boundedSpawnSync.push({ command, args: [...args], options: { ...spawnOptions } });
      if (args[0] === 'get-default') return { status: 0, stdout: `${defaultTargets.shift() || 'graphical.target'}\n`, stderr: '' };
      if (args[0] === 'show' && args.at(-1) === 'graphical.target') {
        return { status: 0, stdout: `${options.targetLoadState || 'loaded'}\n`, stderr: '' };
      }
      if (args[0] === 'show' && args.at(-1) === 'display-manager.service') {
        return { status: 0, stdout: `${options.displayManagerLoadState || 'loaded'}\n`, stderr: '' };
      }
      if (args[0] === 'is-enabled') {
        const enablement = options.displayManagerEnablement || 'enabled';
        return { status: options.displayManagerEnabled === false ? 1 : 0, stdout: `${enablement}\n`, stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
    async run(command, args, runOptions) {
      calls.run.push({ command, args: [...args], options: { ...runOptions } });
      if (options.setFailure && args[0] === 'set-default' && args[1] === 'graphical.target') {
        throw Object.assign(new Error('set-default failed'), { code: 'COMMAND_FAILED' });
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    actionLog(action, level, message, data) {
      calls.logs.push({ action, level, message, data });
    },
    arcaneError(code, message, resolution, status, data) {
      return Object.assign(new Error(message), { code, resolution, status, ...(data || {}) });
    },
  };
  return { adapter: sandbox.createAdapter(ctx), calls };
}

test('fresh Linux policy uses absolute systemctl argv and verifies graphical.target', async () => {
  const { adapter, calls } = createHarness();
  const result = await adapter.configureGraphicalTarget({ id: 'install' }, policy);

  assert.equal(result.policyVersion, 1);
  assert.equal(result.target, 'graphical.target');
  assert.equal(result.previousTarget, 'multi-user.target');
  assert.equal(result.changed, true);
  assert.equal(result.verification, 'verified');
  assert.deepEqual(calls.run.map(({ command, args }) => [command, args]), [
    ['/usr/bin/systemctl', ['set-default', 'graphical.target']],
  ]);
  assert.equal(calls.run.some(({ command }) => /sudo/i.test(command)), false);
  assert.equal(calls.boundedSpawnSync.filter(({ args }) => args[0] === 'get-default').length, 2);
  assert(calls.boundedSpawnSync.every(({ options }) => options.timeout === 10000));
});

test('WSLg is explicit manual-launch mode and performs no systemd mutation', async () => {
  const { adapter, calls } = createHarness({ wsl: true });
  assert.equal(adapter.osInfo(false).sessionType, 'wslg');
  const result = await adapter.configureGraphicalTarget({ id: 'install' }, policy);

  assert.equal(result.applicable, false);
  assert.equal(result.reason, 'wsl');
  assert.equal(result.sessionType, 'manual-wslg');
  assert.deepEqual(calls.run, []);
  assert.deepEqual(calls.boundedSpawnSync, []);
});

test('WSLg installation never registers a display-manager session', async () => {
  const { adapter, calls } = createHarness({ wsl: true, sessionExists: false });
  const integration = await adapter.applyInstallPermissions({ id: 'wsl-install' });
  assert.equal(integration.sessionEntryCreated, false);
  assert.equal(calls.writes.some(({ path: writtenPath }) => writtenPath === '/usr/share/xsessions/arcane-os.desktop'), false);
});

test('update and repair reject an unsafe existing X11 session even when its bytes match', async () => {
  for (const options of [
    { sessionUid: 1000 },
    { desktopMode: 0o100666 },
    { sessionSymlink: true },
  ]) {
    const { adapter, calls } = createHarness(options);
    await assert.rejects(adapter.applyInstallPermissions({ id: 'repair' }), { code: 'LINUX_DESKTOP_SESSION_UNVERIFIED' });
    assert.equal(calls.run.some(({ args }) => args[0] === 'set-default'), false);
  }
});

test('standard users and Linux hosts without systemctl cannot change the target', async () => {
  for (const [options, code] of [
    [{ uid: 1000 }, 'ROOT_REQUIRED'],
    [{ systemctl: false }, 'SYSTEMD_REQUIRED'],
  ]) {
    const { adapter, calls } = createHarness(options);
    await assert.rejects(adapter.configureGraphicalTarget({ id: code }, policy), { code });
    assert.deepEqual(calls.run, []);
  }
});

test('systemd, graphical target, display manager, and Arcane session fail closed before mutation', async () => {
  const cases = [
    [{ initProcess: 'init' }, 'SYSTEMD_NOT_ACTIVE'],
    [{ targetLoadState: 'not-found' }, 'LINUX_GRAPHICAL_TARGET_UNAVAILABLE'],
    [{ displayManagerEnabled: false }, 'LINUX_DISPLAY_MANAGER_REQUIRED'],
    [{ sessionValid: false }, 'LINUX_DESKTOP_SESSION_UNVERIFIED'],
    [{ sessionUid: 1000 }, 'LINUX_DESKTOP_SESSION_UNVERIFIED'],
    [{ sessionMode: 0o100666 }, 'LINUX_DESKTOP_SESSION_UNVERIFIED'],
    [{ sessionSymlink: true }, 'LINUX_DESKTOP_SESSION_UNVERIFIED'],
  ];
  for (const [options, code] of cases) {
    const { adapter, calls } = createHarness(options);
    await assert.rejects(adapter.configureGraphicalTarget({ id: code }, policy), { code });
    assert.deepEqual(calls.run, []);
  }
});

test('postcondition failure restores the recorded prior target', async () => {
  const { adapter, calls } = createHarness({
    defaultTargets: ['multi-user.target', 'multi-user.target', 'multi-user.target'],
  });
  await assert.rejects(adapter.configureGraphicalTarget({ id: 'install' }, policy), (error) => {
    assert.equal(error.code, 'LINUX_GRAPHICAL_TARGET_VERIFY_FAILED');
    assert.equal(error.restoredPreviousTarget, true);
    return true;
  });
  assert.deepEqual(calls.run.map(({ command, args }) => [command, args]), [
    ['/usr/bin/systemctl', ['set-default', 'graphical.target']],
    ['/usr/bin/systemctl', ['set-default', 'multi-user.target']],
  ]);
});

test('already-graphical installs are idempotent and explicit rollback restores a changed target', async () => {
  const current = createHarness({ defaultTargets: ['graphical.target', 'graphical.target'] });
  const result = await current.adapter.configureGraphicalTarget({ id: 'install' }, policy);
  assert.equal(result.changed, false);
  assert.deepEqual(current.calls.run.map(({ args }) => args), [['set-default', 'graphical.target']]);

  const recovery = createHarness({ defaultTargets: ['multi-user.target'] });
  const rollback = await recovery.adapter.rollbackGraphicalTarget({ changed: true, previousTarget: 'multi-user.target' }, { id: 'rollback' });
  assert.equal(rollback.restored, true);
  assert.equal(rollback.target, 'multi-user.target');
  assert.deepEqual(recovery.calls.run.map(({ command, args }) => [command, args]), [
    ['/usr/bin/systemctl', ['set-default', 'multi-user.target']],
  ]);
});

test('Core applies the policy only on first install and rolls it back before filesystem recovery', () => {
  assert.match(coreSource, /if \(!movedExisting && native\.configureGraphicalTarget\)/);
  assert.match(coreSource, /graphicalConfiguration = await native\.configureGraphicalTarget\(action, linuxPolicy\)/);
  assert.match(coreSource, /if \(graphicalConfiguration && native\.rollbackGraphicalTarget\)[\s\S]*?await native\.rollbackGraphicalTarget\(graphicalConfiguration, action\);[\s\S]*?if \(installIntegration && native\.rollbackInstallIntegration\)/);
  const permissionBlock = adapterSource.slice(
    adapterSource.indexOf('async function applyInstallPermissions'),
    adapterSource.indexOf('async function applyStatePermissions')
  );
  assert.doesNotMatch(permissionBlock, /configureGraphicalTarget/);
});

test('Core transaction restores the target and session integration after a later install failure', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-graphical-rollback-'));
  const installRoot = path.join(fixture, 'install');
  const stateRoot = path.join(fixture, 'state');
  const sourceFile = path.join(fixture, 'payload');
  const bundleManifest = path.join(fixture, 'arcane-bundle.json');
  await fs.writeFile(sourceFile, 'verified');
  await fs.writeFile(bundleManifest, '{}');
  const recovery = [];
  let sessionRegistered = false;
  let target = 'multi-user.target';
  const native = {
    id: 'linux',
    async acquireInstallLease() { return { held: true }; },
    async releaseInstallLease() {},
    installPayload() {
      return {
        mode: 'linux-webkitgtk', releaseReady: true, selfHosted: false,
        files: [{ source: sourceFile, installPath: 'bin/payload' }], directories: [],
        bundleManifestSource: bundleManifest, securityMode: 'unsigned-local-test',
      };
    },
    captureInstallStageOwnership() { return { owned: true }; },
    installStageOwnershipStatus() { return { state: 'owned' }; },
    async cleanupInstallStage(_ownership, candidate) { await fs.rm(candidate, { recursive: true, force: true }); },
    async writeLaunchers() {},
    async applyInstallPermissions() { sessionRegistered = true; return { sessionEntryCreated: true }; },
    async rollbackInstallIntegration() { recovery.push('session'); sessionRegistered = false; },
    async applyStatePermissions() {},
    async configureGraphicalTarget() {
      target = 'graphical.target';
      return { policyVersion: 1, applicable: true, target, previousTarget: 'multi-user.target', changed: true, sessionType: 'x11', verification: 'verified' };
    },
    async rollbackGraphicalTarget(configuration) { recovery.push('target'); target = configuration.previousTarget; },
  };
  const context = vm.createContext({
    native, simulate: false, platform: 'linux', allowSourceInstall: false,
    PATHS: { installRoot, stateRoot }, VERSION: '0.8.4',
    BUNDLE_MANIFEST: { requirements: {}, installation: { linux: policy } },
    process: { pid: 4421 }, crypto, fsp: fs, fs: fsSync, path,
    bundleRoot() { return fixture; },
    async recoverInterruptedInstallation() { return { recovered: false }; },
    actionLog() {}, normalizeIntegrityPath(value) { return String(value); },
    integrityFilePath(base, relative) { return path.join(base, ...String(relative).split('/')); },
    async ensureDir(directory) { await fs.mkdir(directory, { recursive: true }); },
    async copyTree() { throw new Error('copyTree must not run'); },
    verifyIntegrityEntries() { return { ok: true }; },
    createInstalledIntegrity() { return { schemaVersion: 2, hashAlgorithm: 'sha256', scope: 'installed-tree', files: [] }; },
    currentIdentity() { return { username: 'root' }; }, osInfo() { return { platform: 'linux' }; },
    activeReleaseSecurityMode() { return 'unsigned-local-test'; },
    async writeFile(file, contents) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, contents); },
    verifyInstalledIntegrity() { return { ok: true }; },
    async durableWriteFile(file) {
      if (file === path.join(installRoot, 'arcane-install.json')) throw new Error('synthetic post-configuration failure');
    },
    readJsonFile() { return null; }, verifyInstalledIntegrityAt() { return { ok: false, reason: 'absent' }; },
    async snapshotActiveInstallationForRollback() { return null; },
    stamp() { return new Date(0).toISOString(); },
    arcaneError(code, message, resolution, status, details) { return Object.assign(new Error(message), { code, resolution, status, details }); },
  });
  try {
    vm.runInContext(coreFunctionSource('async function installArcaneGlobally(action)', 'async function ensureArcaneInstallation'), context);
    await assert.rejects(context.installArcaneGlobally({ id: 'rollback' }), /synthetic post-configuration failure/);
    assert.deepEqual(recovery, ['target', 'session']);
    assert.equal(target, 'multi-user.target');
    assert.equal(sessionRegistered, false);
    assert.equal(fsSync.existsSync(installRoot), false);
    assert.equal((await fs.readdir(fixture)).some((name) => name.startsWith('install.stage-') || name.startsWith('install.failed-')), false);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('Linux installation registers only an X11 display-manager session', () => {
  assert.deepEqual(bundle.installation.linux, policy);
  assert.match(adapterSource, /'bin\/arcane-session': '#!\/bin\/sh/);
  assert.match(adapterSource, /if \(!isWindowsSubsystemForLinux\(\)\) \{\s+const sessionEntryPath = '\/usr\/share\/xsessions\/arcane-os\.desktop'/);
  assert.match(adapterSource, /\/usr\/share\/xsessions\/arcane-os\.desktop/);
  assert.doesNotMatch(adapterSource, /\/usr\/share\/wayland-sessions\/arcane-os\.desktop/);
  assert.doesNotMatch(adapterSource, /ctx\.run\(['"]sudo['"]/);
  assert.doesNotMatch(adapterSource.slice(adapterSource.indexOf('function readSystemdDefaultTarget'), adapterSource.indexOf('function assertInstalledLinuxSession')), /ctx\.spawnSync/);
  assert.match(coreSource, /function boundedSpawnSync[\s\S]*?env: opts\.env \|\| safeSubprocessEnvironment[\s\S]*?timeout:/);
});
