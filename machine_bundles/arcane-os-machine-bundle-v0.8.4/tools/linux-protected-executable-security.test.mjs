import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.dirname(toolsRoot);
const adapterPath = path.join(bundleRoot, 'src', 'native', 'linux.cjs');
const adapterSource = await fs.readFile(adapterPath, 'utf8');
const returnMarker = "  return Object.freeze({\n    id: 'linux',";
assert.equal(adapterSource.split(returnMarker).length - 1, 1, 'expected one Linux adapter return marker');
const testableAdapterSource = adapterSource.replace(
  returnMarker,
  "  return Object.freeze({\n    __testRequiredAccountCommand: requiredAccountCommand,\n    id: 'linux',",
);

const stateRoot = '/var/lib/arcane-os/state';
const stateFile = `${stateRoot}/users.json`;
const firstCandidate = '/usr/local/sbin/chmod';
const cargoTarget = '/usr/lib/cargo/bin/coreutils/chmod';
const safeCandidate = '/usr/bin/chmod';
const linuxOpenConstants = Object.freeze({
  ...fsSync.constants,
  O_RDONLY: 0,
  O_NONBLOCK: 0o4000,
  O_DIRECTORY: 0o200000,
  O_NOFOLLOW: 0o400000,
  O_CLOEXEC: 0o2000000,
});

function createHarness(options = {}) {
  const sandbox = {
    Buffer,
    process: {
      arch: 'x64',
      platform: 'linux',
      pid: 4872,
      execPath: '/opt/arcane-os/bin/ArcaneCore',
      env: {
        ARCANE_INSTALL_ROOT: '/opt/arcane-os',
        ARCANE_STATE_ROOT: stateRoot,
      },
      getuid: () => 0,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    `${testableAdapterSource}\nglobalThis.createAdapter = createLinuxNativeAdapter;`,
    sandbox,
    { filename: adapterPath },
  );

  const entries = new Map();
  const inodeByPath = new Map();
  let nextInode = 100;
  const inodeFor = (entryPath) => {
    if (!inodeByPath.has(entryPath)) inodeByPath.set(entryPath, nextInode++);
    return inodeByPath.get(entryPath);
  };
  const addDirectory = (entryPath, overrides = {}) => entries.set(entryPath, {
    type: 'directory', uid: 0, mode: 0o755, nlink: 2, dev: 1, ino: inodeFor(entryPath), ...overrides,
  });
  const addFile = (entryPath, overrides = {}) => entries.set(entryPath, {
    type: 'file', uid: 0, mode: 0o755, nlink: 1, dev: 1, ino: inodeFor(entryPath), ...overrides,
  });
  for (const directory of [
    '/', '/usr', '/usr/local', '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/usr/lib',
    '/usr/lib/cargo', '/usr/lib/cargo/bin', '/usr/lib/cargo/bin/coreutils', '/sbin', '/bin',
    '/var', '/var/lib', '/var/lib/arcane-os', stateRoot,
  ]) addDirectory(directory);
  if (options.aliasParentMode !== undefined) entries.get('/usr/local/sbin').mode = options.aliasParentMode;
  if (options.targetParentMode !== undefined) entries.get('/usr/lib/cargo/bin/coreutils').mode = options.targetParentMode;
  if (options.stateRoot === false) entries.delete(stateRoot);
  if (options.stateFile !== false) addFile(stateFile, { mode: 0o640, nlink: options.stateFileNlink ?? 1 });
  if (options.firstCandidate !== false) addFile(firstCandidate);
  addFile(cargoTarget, { nlink: options.cargoNlink ?? 2, ...(options.cargoStat || {}) });
  if (options.safeCandidate !== false) addFile(safeCandidate, { mode: 0o755 });

  const existsCalls = [];
  const realpathCalls = [];
  const openCalls = [];
  const chmodCalls = [];
  const runCalls = [];
  const fsFacade = {
    constants: linuxOpenConstants,
    existsSync(entryPath) {
      existsCalls.push(entryPath);
      return entries.has(entryPath);
    },
    realpathSync(entryPath) {
      realpathCalls.push(entryPath);
      if (entryPath === firstCandidate) return cargoTarget;
      if (entries.has(entryPath)) return entryPath;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    lstatSync(entryPath) {
      const entry = entries.get(entryPath);
      if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        uid: entry.uid,
        gid: entry.gid ?? 0,
        mode: entry.mode,
        nlink: entry.nlink,
        dev: entry.dev,
        ino: entry.ino,
        isDirectory: () => entry.type === 'directory',
        isFile: () => entry.type === 'file',
        isSymbolicLink: () => entry.type === 'symlink',
      };
    },
    readFileSync(entryPath) {
      if (entryPath === '/proc/sys/kernel/osrelease' || entryPath === '/proc/version') {
        return '6.6.87.2-microsoft-standard-WSL2';
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  };
  const fsp = {
    async mkdir(entryPath, mkdirOptions) {
      if (entries.has(entryPath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      addDirectory(entryPath, { mode: mkdirOptions.mode });
    },
    async open(entryPath, flags) {
      openCalls.push({ path: entryPath, flags });
      const openedInode = entries.get(entryPath)?.ino;
      if (openedInode === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      let statCount = 0;
      return {
        async stat() {
          statCount += 1;
          const stat = fsFacade.lstatSync(entryPath);
          if (options.swapOnOpen === entryPath && statCount === 1) return { ...stat, ino: stat.ino + 1000 };
          return stat;
        },
        async chmod(mode) {
          assert.equal(entries.get(entryPath).ino, openedInode, 'test fixture entry identity changed unexpectedly');
          chmodCalls.push([entryPath, mode]);
          entries.get(entryPath).mode = mode;
        },
        async close() {},
      };
    },
    async rm() {},
    async symlink() {},
    async copyFile() {},
  };
  const ctx = {
    production: false,
    hostPlatform: 'linux',
    simulate: false,
    path: path.posix,
    os: {
      homedir: () => '/root',
      hostname: () => 'arcane-test',
      release: () => 'test',
      userInfo: () => ({ username: 'root' }),
    },
    fs: fsFacade,
    fsp,
    crypto,
    async ensureDir() {},
    async writeFile() {},
    async run(command, args) { runCalls.push([command, [...args]]); return { code: 0, stdout: '', stderr: '' }; },
    boundedSpawnSync() { throw new Error('unexpected bounded subprocess'); },
    arcaneError(code, message, resolution, status, details) {
      return Object.assign(new Error(message), { code, resolution, status, details, ...(details || {}) });
    },
  };
  return {
    adapter: sandbox.createAdapter(ctx),
    entries,
    existsCalls,
    realpathCalls,
    openCalls,
    chmodCalls,
    runCalls,
  };
}

test('protected Linux executable policy accepts a root-owned hardlinked executable', () => {
  const fixture = createHarness();
  assert.equal(fixture.adapter.__testRequiredAccountCommand('chmod'), cargoTarget);
  assert.deepEqual(fixture.realpathCalls, [firstCandidate]);
});

test('protected Linux executable policy skips unsafe candidates and selects a safe later canonical path', () => {
  const invalidCandidates = [
    { uid: 1000 },
    { mode: 0o775 },
    { mode: 0o757 },
    { mode: 0o644 },
    { type: 'directory' },
  ];
  for (const cargoStat of invalidCandidates) {
    const fixture = createHarness({ cargoStat });
    assert.equal(fixture.adapter.__testRequiredAccountCommand('chmod'), safeCandidate);
    assert.deepEqual(fixture.realpathCalls, [firstCandidate, safeCandidate]);
    assert.deepEqual(fixture.existsCalls.filter((entryPath) => entryPath.endsWith('/chmod')), [
      '/usr/local/sbin/chmod',
      '/usr/local/bin/chmod',
      '/usr/sbin/chmod',
      '/usr/bin/chmod',
    ]);
  }
});

test('protected Linux executable policy rejects writable ancestry and fails closed without a safe candidate', () => {
  const fallback = createHarness({ aliasParentMode: 0o777 });
  assert.equal(fallback.adapter.__testRequiredAccountCommand('chmod'), safeCandidate);
  assert.deepEqual(fallback.realpathCalls, [safeCandidate]);

  const rejected = createHarness({ cargoStat: { mode: 0o777 }, safeCandidate: false });
  assert.throws(
    () => rejected.adapter.__testRequiredAccountCommand('chmod'),
    (error) => error.code === 'LINUX_PROTECTED_FILE_UNSAFE' && error.path === cargoTarget,
  );
  assert.deepEqual(rejected.runCalls, []);
});

test('Linux state permissions use no-follow file handles and no external chmod process', async () => {
  const fixture = createHarness();
  await fixture.adapter.applyStatePermissions({ id: 'state-permissions' });
  assert.deepEqual(fixture.chmodCalls, [
    [stateRoot, 0o755],
    [stateFile, 0o600],
  ]);
  assert.deepEqual(fixture.runCalls, []);
  assert.equal((fixture.openCalls[0].flags & linuxOpenConstants.O_NOFOLLOW) !== 0, true);
  assert.equal((fixture.openCalls[0].flags & linuxOpenConstants.O_DIRECTORY) !== 0, true);
  assert.equal((fixture.openCalls[1].flags & linuxOpenConstants.O_NOFOLLOW) !== 0, true);
});

test('Linux state permissions retain single-link data checks and reject changed file identity', async () => {
  const hardlinked = createHarness({ stateFileNlink: 2 });
  await assert.rejects(hardlinked.adapter.applyStatePermissions({ id: 'hardlink' }), { code: 'LINUX_STATE_FILE_UNSAFE' });
  assert.deepEqual(hardlinked.chmodCalls, [[stateRoot, 0o755]]);

  const changed = createHarness({ swapOnOpen: stateFile });
  await assert.rejects(changed.adapter.applyStatePermissions({ id: 'changed' }), { code: 'LINUX_STATE_ENTRY_CHANGED' });
  assert.deepEqual(changed.chmodCalls, [[stateRoot, 0o755]]);
});

test('Linux install integration does not run recursive external chown or chmod', async () => {
  const fixture = createHarness();
  const result = await fixture.adapter.applyInstallPermissions({ id: 'wsl-install' });
  assert.equal(result.sessionEntryCreated, false);
  assert.equal(
    fixture.runCalls.some(([command]) => ['chown', 'chmod'].includes(path.posix.basename(String(command)))),
    false,
  );
});
