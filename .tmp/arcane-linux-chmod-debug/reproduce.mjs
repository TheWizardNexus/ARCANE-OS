import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const adapterPath = path.resolve(
  'machine_bundles/arcane-os-machine-bundle-v0.8.4/src/native/linux.cjs',
);
const originalSource = await fs.readFile(adapterPath, 'utf8');
const stateRoot = '/var/lib/arcane-os/state-test';
const stateFile = `${stateRoot}/users.json`;
const hostileCandidate = '/usr/local/sbin/chmod';
const hostileCanonical = '/usr/lib/cargo/bin/coreutils/chmod';
const safeCandidate = '/usr/bin/chmod';

function stat({ directory = false, uid = 0, nlink = 1, mode = directory ? 0o755 : 0o755 } = {}) {
  return {
    uid,
    nlink,
    mode,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
  };
}

function createHarness(source) {
  const sandbox = {
    Buffer,
    process: {
      arch: 'x64',
      platform: 'linux',
      pid: 4242,
      execPath: '/opt/arcane-os/bin/ArcaneCore',
      env: {
        ARCANE_INSTALL_ROOT: '/opt/arcane-os',
        ARCANE_STATE_ROOT: stateRoot,
      },
      getuid: () => 0,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${source}\nglobalThis.createAdapter = createLinuxNativeAdapter;`, sandbox, {
    filename: 'linux.cjs',
  });

  const realpathCalls = [];
  const runCalls = [];
  const chmodCalls = [];
  const existing = new Set([stateRoot, stateFile, hostileCandidate, safeCandidate]);
  const linuxPath = Object.assign({}, path.posix, { posix: path.posix });
  const fsFacade = {
    existsSync: (entryPath) => existing.has(entryPath),
    realpathSync(entryPath) {
      realpathCalls.push(entryPath);
      if (entryPath === hostileCandidate) return hostileCanonical;
      if (entryPath === safeCandidate) return safeCandidate;
      throw new Error(`unexpected realpath: ${entryPath}`);
    },
    lstatSync(entryPath) {
      if (entryPath === stateRoot) return stat({ directory: true, mode: 0o755 });
      if (entryPath === stateFile) return stat({ mode: 0o600 });
      if (entryPath === hostileCanonical) return stat({ nlink: 2, mode: 0o755 });
      if (entryPath === safeCandidate) return stat({ mode: 0o755 });
      throw new Error(`unexpected lstat: ${entryPath}`);
    },
  };
  const adapter = sandbox.createAdapter({
    production: false,
    hostPlatform: 'linux',
    simulate: false,
    path: linuxPath,
    os: {
      homedir: () => '/root',
      hostname: () => 'arcane-test',
      release: () => 'test',
    },
    fs: fsFacade,
    fsp: {
      async mkdir() {},
      async chmod(entryPath, mode) { chmodCalls.push([entryPath, mode]); },
    },
    async run(command, args) { runCalls.push([command, Array.from(args)]); },
    arcaneError(code, message, resolution, status, details) {
      return Object.assign(new Error(message), { code, resolution, status, details });
    },
  });
  return { adapter, realpathCalls, runCalls, chmodCalls };
}

const before = createHarness(originalSource);
let observedError = null;
try {
  await before.adapter.applyStatePermissions({ id: 'reproduce' });
} catch (error) {
  observedError = error;
}
assert.equal(observedError?.code, 'LINUX_PROTECTED_FILE_UNSAFE');
assert.equal(observedError?.details?.path, hostileCanonical);
assert.deepEqual(before.realpathCalls, [hostileCandidate]);
assert.deepEqual(before.runCalls, []);
assert.deepEqual(before.chmodCalls, []);

const manuallyCorrectedSource = originalSource
  .replace(
    "await ctx.run(requiredAccountCommand('chmod'), ['0755', paths.stateRoot], { action });",
    'await ctx.fsp.chmod(paths.stateRoot, 0o755);',
  )
  .replace(
    "await ctx.run(requiredAccountCommand('chmod'), ['0600', file], { action });",
    'await ctx.fsp.chmod(file, 0o600);',
  );
assert.notEqual(manuallyCorrectedSource, originalSource);

const after = createHarness(manuallyCorrectedSource);
await after.adapter.applyStatePermissions({ id: 'manual-proof' });
assert.deepEqual(after.realpathCalls, []);
assert.deepEqual(after.runCalls, []);
assert.deepEqual(after.chmodCalls, [
  [stateRoot, 0o755],
  [stateFile, 0o600],
]);

console.log(JSON.stringify({
  reproduced: {
    code: observedError.code,
    rejectedPath: observedError.details.path,
    laterSafeCandidateIgnored: !before.realpathCalls.includes(safeCandidate),
  },
  manualCorrection: {
    externalCommands: after.runCalls.length,
    chmodCalls: after.chmodCalls,
  },
}, null, 2));
