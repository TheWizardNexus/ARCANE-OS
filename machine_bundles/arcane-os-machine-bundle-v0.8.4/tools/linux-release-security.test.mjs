import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createReleaseManifest } from './release-integrity.mjs';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.dirname(toolsRoot);
const adapterSource = await fs.readFile(path.join(bundleRoot, 'src', 'native', 'linux.cjs'), 'utf8');
const hostSource = await fs.readFile(path.join(bundleRoot, 'src', 'hosts', 'linux', 'arcane_host.c'), 'utf8');
const coreSource = await fs.readFile(path.join(bundleRoot, 'src', 'core', 'arcane-core.template.cjs'), 'utf8');
const bundle = JSON.parse(await fs.readFile(path.join(bundleRoot, 'arcane-bundle.json'), 'utf8'));

function protectedFixtureFs(fixture, overrides = {}) {
  const fixtureRoot = path.resolve(fixture);
  const fixturePrefix = `${fixtureRoot}${path.sep}`;
  return new Proxy(fsSync, {
    get(target, property) {
      if (property === 'readSync' && typeof overrides.beforeReadSync === 'function') {
        return (fd, ...args) => {
          overrides.beforeReadSync(fd);
          return target.readSync(fd, ...args);
        };
      }
      if (property !== 'lstatSync') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (entryPath, ...args) => {
        const stat = target.lstatSync(entryPath, ...args);
        const resolved = path.resolve(String(entryPath));
        if (resolved !== fixtureRoot && !resolved.startsWith(fixturePrefix)) return stat;
        const typedInteger = (value, current) => typeof current === 'bigint' ? BigInt(value) : Number(value);
        const baselineMode = process.platform === 'linux'
          ? typeof stat.mode === 'bigint' ? Number(stat.mode & 0o7777n) : stat.mode & 0o7777
          : (Number(stat.mode) & ~0o022) | (stat.isDirectory()
            || /[/\\]bin[/\\](?:ArcaneCore|ArcaneProvisioner|ArcaneShell|arcane-(?:shell|provisioner|session))$/.test(resolved) ? 0o111 : 0);
        const simulatedMode = typeof overrides.modeFor === 'function'
          ? overrides.modeFor(resolved, stat, baselineMode)
          : baselineMode;
        const protectedStat = new Proxy(stat, {
          get(statTarget, statProperty) {
            if (statProperty === 'uid') {
              const value = typeof overrides.uidFor === 'function' ? overrides.uidFor(resolved, statTarget) : 0;
              return typedInteger(value, statTarget.uid);
            }
            if (statProperty === 'gid' && typeof overrides.gidFor === 'function') {
              return typedInteger(overrides.gidFor(resolved, statTarget), statTarget.gid);
            }
            if (statProperty === 'mode') return typedInteger(simulatedMode, statTarget.mode);
            if (statProperty === 'dev' && typeof overrides.devFor === 'function') {
              return typedInteger(overrides.devFor(resolved, statTarget), statTarget.dev);
            }
            if (statProperty === 'ino' && typeof overrides.inoFor === 'function') {
              return typedInteger(overrides.inoFor(resolved, statTarget), statTarget.ino);
            }
            const value = Reflect.get(statTarget, statProperty, statTarget);
            return typeof value === 'function' ? value.bind(statTarget) : value;
          },
        });
        if (typeof overrides.afterLstatSync === 'function') overrides.afterLstatSync(resolved, protectedStat);
        return protectedStat;
      };
    },
  });
}

function createAdapter(fixture, overrides = {}) {
  const {
    processExecPath = path.join(fixture, 'release', 'ArcaneCore'),
    processEnvironment = {},
    ...contextOverrides
  } = overrides;
  const sandbox = {
    Buffer,
    process: {
      arch: 'x64',
      platform: 'linux',
      pid: process.pid,
      execPath: processExecPath,
      env: {
        ARCANE_INSTALL_ROOT: path.join(fixture, 'installed'),
        ARCANE_STATE_ROOT: path.join(fixture, 'state'),
        ...processEnvironment,
      },
      getuid: () => 0,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${adapterSource}\nglobalThis.createAdapter = createLinuxNativeAdapter;`, sandbox, { filename: 'linux.cjs' });
  const ctx = {
    production: false,
    hostPlatform: 'test',
    simulate: false,
    allowUnsignedLocalRelease: true,
    releaseSecurityModeClaim: 'unsigned-local-test',
    releaseContentBindingClaim: '',
    releaseSignerThumbprintClaim: '',
    releaseVerifiedAtClaim: '',
    releaseRevocationStatusClaim: '',
    releaseTrustSourceClaim: '',
    releaseTimestampVerifiedClaim: false,
    bundleVersion: bundle.version,
    path,
    os,
    fs: protectedFixtureFs(fixture),
    fsp: fs,
    crypto,
    async writeFile(file, contents, mode) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents, { mode });
      await fs.chmod(file, mode);
    },
    arcaneError(code, message, resolution, status, details) {
      return Object.assign(new Error(message), { code, resolution, status, details });
    },
    ...contextOverrides,
  };
  return sandbox.createAdapter(ctx);
}

async function createReleaseFixture(fixture) {
  const releaseRoot = path.join(fixture, 'release');
  await fs.mkdir(releaseRoot, { recursive: false });
  await fs.cp(path.join(bundleRoot, 'dist', 'app'), path.join(releaseRoot, 'app'), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await fs.copyFile(path.join(bundleRoot, 'arcane-bundle.json'), path.join(releaseRoot, 'arcane-bundle.json'));
  for (const executable of ['ArcaneCore', 'ArcaneProvisioner', 'ArcaneShell']) {
    await fs.writeFile(path.join(releaseRoot, executable), `fixture:${executable}\n`, { mode: 0o755 });
  }
  const manifest = await createReleaseManifest({
    dist: releaseRoot,
    bundle,
    platform: 'linux',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await fs.writeFile(path.join(releaseRoot, 'arcane-release.json'), JSON.stringify(manifest, null, 2));
  await protectTree(releaseRoot);
  return releaseRoot;
}

async function protectTree(root) {
  const visit = async (directory) => {
    await fs.chmod(directory, 0o755);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else await fs.chmod(target, target.endsWith('ArcaneCore') || target.endsWith('ArcaneProvisioner') || target.endsWith('ArcaneShell') || path.basename(target).startsWith('arcane-') ? 0o755 : 0o644);
    }
  };
  await visit(root);
}

async function poisonTreeMetadata(root, uid, gid) {
  const visit = async (target) => {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target)) await visit(path.join(target, entry));
    }
    await fs.chown(target, uid, gid);
    await fs.chmod(target, 0o777);
  };
  await visit(root);
}

function stagePathFor(adapter, marker = 'a') {
  return `${adapter.paths.installRoot}.stage-${process.pid}-${marker.repeat(48)}`;
}

async function assertCanonicalInstalledTree(root) {
  const executable = new Set([
    'bin/ArcaneCore', 'bin/ArcaneProvisioner', 'bin/ArcaneShell',
    'bin/arcane-provisioner', 'bin/arcane-session', 'bin/arcane-shell',
  ]);
  const visit = async (directory, relativeDirectory) => {
    const directoryStat = await fs.lstat(directory);
    assert.equal(directoryStat.uid, 0);
    assert.equal(directoryStat.gid, 0);
    assert.equal(directoryStat.mode & 0o7777, 0o755);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stat = await fs.lstat(target);
      assert.equal(stat.isSymbolicLink(), false, relativePath);
      if (entry.isDirectory()) await visit(target, relativePath);
      else {
        assert.equal(entry.isFile(), true, relativePath);
        assert.equal(stat.uid, 0, relativePath);
        assert.equal(stat.gid, 0, relativePath);
        assert.equal(stat.nlink, 1, relativePath);
        assert.equal(stat.mode & 0o7777, executable.has(relativePath) ? 0o755 : 0o644, relativePath);
      }
    }
  };
  await visit(root, '');
}

async function materializeStage(adapter, payload, stage) {
  await fs.mkdir(stage, { recursive: false, mode: 0o700 });
  await adapter.prepareInstallStage(stage);
  for (const file of payload.files) {
    const target = path.join(stage, ...String(file.installPath || `bin/${file.destinationName}`).split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file.source, target);
  }
  for (const directory of payload.directories || []) {
    await fs.cp(directory.source, path.join(stage, directory.destinationName), { recursive: true, force: false, errorOnExist: true });
  }
  await fs.copyFile(payload.bundleManifestSource, path.join(stage, 'arcane-bundle.json'));
  await adapter.writeLaunchers(stage, payload);
  await protectTree(stage);
}

function installedIntegrity(root) {
  const files = [];
  const visit = (directory, relativeDirectory) => {
    for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, relative);
      else if (relative !== 'arcane-install.json') {
        const contents = fsSync.readFileSync(target);
        files.push({ path: relative.replaceAll('\\', '/'), size: contents.length, sha256: crypto.createHash('sha256').update(contents).digest('hex') });
      }
    }
  };
  visit(root, '');
  return { schemaVersion: 2, hashAlgorithm: 'sha256', scope: 'installed-tree', files: files.sort((left, right) => left.path.localeCompare(right.path, 'en')) };
}

test('Linux host strips ambient release claims and forwards only explicit unsigned-local consent', () => {
  assert.match(hostSource, /capture_exact_main_option_tokens[\s\S]*?g_strcmp0\(argument, "--allow-unsigned-local-release"\)/);
  assert.match(hostSource, /capture_local_options[\s\S]*?g_variant_dict_lookup\(options, "allow-unsigned-local-release", "b"/);
  assert.match(hostSource, /parsed_unsigned_local_option != host->exact_unsigned_local_option/);
  assert.match(hostSource, /register_main_options[\s\S]*?"handle-local-options"[\s\S]*?capture_local_options/);
  assert.match(hostSource, /if \(host->allow_unsigned_local_release\) g_ptr_array_add\(arguments, g_strdup\("--allow-unsigned-local-release"\)\)/);
  assert.match(hostSource, /g_subprocess_launcher_unsetenv\(launcher, release_claim_names\[index\]\)/);
  assert.match(hostSource, /g_subprocess_launcher_setenv\(launcher, "ARCANE_RELEASE_SECURITY_MODE", "unsigned-local-test", TRUE\)/);
  assert.match(hostSource, /g_application_add_main_option[\s\S]*?"allow-unsigned-local-release"/);
  assert.match(coreSource, /if \(platform !== 'win32'\) throw new Error\('Arcane Core does not accept publisher-verified claims/);
  assert.match(adapterSource, /releaseRootStat\.isDirectory\(\)[\s\S]*?releaseRootStat\.isSymbolicLink\(\)/);
  assert.match(adapterSource, /releaseManifestStat\.isFile\(\)[\s\S]*?releaseManifestStat\.isSymbolicLink\(\)/);
  assert.match(adapterSource, /linuxInstalledExecutablePaths = new Set\([\s\S]*?'bin\/ArcaneCore'[\s\S]*?'bin\/arcane-shell'/);
  assert.match(adapterSource, /!statIntegerEquals\(stat\.nlink, 1\) \|\| permissionBits\(stat\) !== expectedMode/);
});

test('non-packaged Linux simulation accepts only its exact explicit unsigned-local host claim', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-simulated-release-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const accepted = createAdapter(fixture, {
    simulate: true,
    processPkg: false,
  });
  const rejected = createAdapter(fixture, {
    simulate: true,
    processPkg: false,
    releaseSecurityModeClaim: '',
  });

  assert.equal(accepted.hostReleaseSecurityMode(), 'unsigned-local-test');
  assert.equal(
    accepted.shellCommand(),
    `${path.resolve(fixture, 'installed').replaceAll('\\', '/')}/bin/arcane-shell`
  );
  assert.equal(rejected.hostReleaseSecurityMode(), 'unverified');
  const catalog = await accepted.listInstalledApplications();
  assert.equal(catalog.verified, true);
  assert.equal(catalog.securityMode, 'unsigned-local-test');
  assert.deepEqual(Array.from(catalog.applications), []);
  await assert.rejects(() => rejected.listInstalledApplications(), (error) => {
    assert.equal(error.code, 'APPLICATION_CATALOG_UNVERIFIED');
    return true;
  });
  const simulatedIdentity = createAdapter(fixture, {
    simulate: true,
    processPkg: false,
    processEnvironment: { ARCANE_SIMULATED_USERNAME: 'arcane-guide' },
  }).currentIdentity();
  assert.equal(simulatedIdentity.username, 'arcane-guide');
  assert.equal(simulatedIdentity.accountName, 'arcane-guide');
  assert.equal(simulatedIdentity.displayName, 'arcane-guide');
});

test('Core keeps Linux staging private and orders native materialization before verification', () => {
  const createIndex = coreSource.indexOf("fsp.mkdir(stage, { recursive: false, ...(platform === 'linux' ? { mode: 0o700 } : {}) })");
  const prepareIndex = coreSource.indexOf('native.prepareInstallStage(stage, action)');
  const captureIndex = coreSource.indexOf('native.captureInstallStageOwnership(stage)');
  const materializeIndex = coreSource.indexOf('native.materializeInstallStage(stage, payload, action)');
  const launcherIndex = coreSource.indexOf('native.writeLaunchers(stage, payload)');
  const finalizeIndex = coreSource.indexOf('native.finalizeInstallStage(stage, payload, action)');
  const hashIndex = coreSource.indexOf('verifyIntegrityEntries(stage, payload.integrity.files, true)');
  const nativeVerifyIndex = coreSource.indexOf('native.verifyStagedInstallation(stage, false)');
  assert(createIndex >= 0);
  assert(createIndex < prepareIndex && prepareIndex < captureIndex && captureIndex < materializeIndex);
  assert(materializeIndex < launcherIndex && launcherIndex < finalizeIndex);
  assert(finalizeIndex < hashIndex && hashIndex < nativeVerifyIndex);
  assert.match(coreSource, /else if \(platform === 'win32' \|\| platform === 'linux'\)[\s\S]*?cannot bind an installation stage/);
  assert.match(coreSource, /const activatedOwnership = stageOwnership[\s\S]*?if \(stageOwnership && \(!activatedOwnership \|\| activatedOwnership\.state !== 'owned'\)\)/);
  assert.match(adapterSource, /O_WRONLY \| constants\.O_CREAT \| constants\.O_EXCL \| constants\.O_NOFOLLOW/);
  assert.match(adapterSource, /sourceHandle = await ctx\.fsp\.open\(captured\.source, freshFileFlags\(true\)\)/);
  assert.match(adapterSource, /await handle\.chown\(0, 0\);[\s\S]*?await handle\.chmod\(expectedMode\)/);
});

test('Linux stage ownership distinguishes filesystem identities above the safe-integer limit', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-stage-bigint-'));
  const firstInode = 9007199254740992n;
  const secondInode = 9007199254740993n;
  let stageInode = firstInode;
  let stage = null;
  let adapter = null;
  let ownership = null;
  try {
    assert.equal(Number(firstInode), Number(secondInode), 'the regression requires distinct inodes that collide as Number');
    stage = path.join(fixture, `installed.stage-${process.pid}-${'c'.repeat(48)}`);
    const identityFs = protectedFixtureFs(fixture, {
      inoFor(entryPath, stat) {
        return entryPath === path.resolve(stage) ? stageInode : stat.ino;
      },
    });
    adapter = createAdapter(fixture, { fs: identityFs });
    await fs.mkdir(stage, { recursive: false, mode: 0o700 });
    await adapter.prepareInstallStage(stage);
    ownership = adapter.captureInstallStageOwnership(stage);
    assert.equal(ownership.inode, firstInode.toString(10));
    assert.equal(typeof ownership.device, 'string');

    stageInode = secondInode;
    const changed = adapter.installStageOwnershipStatus(ownership, stage);
    assert.equal(changed.state, 'foreign');
    assert.equal(changed.reason, 'identity-mismatch');
    await assert.rejects(adapter.cleanupInstallStage(ownership, stage), /refused to clean/i);
    assert.equal(fsSync.existsSync(stage), true, 'identity mismatch must preserve the candidate tree');

    for (const malformed of [
      { ...ownership, inode: Number(firstInode) },
      { ...ownership, inode: `0${ownership.inode}` },
      { ...ownership, unexpected: true },
    ]) {
      const status = adapter.installStageOwnershipStatus(malformed, stage);
      assert.equal(status.state, 'uncertain');
      assert.equal(status.reason, 'invalid-ownership-record');
    }

    stageInode = firstInode;
    await adapter.cleanupInstallStage(ownership, stage);
    stage = null;
  } finally {
    if (stage && adapter && ownership && fsSync.existsSync(stage)) {
      stageInode = firstInode;
      await adapter.cleanupInstallStage(ownership, stage).catch(() => {});
    }
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('Linux installPayload rejects a final release file replaced during descriptor verification', {
  skip: process.platform !== 'linux',
}, async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-release-file-race-'));
  try {
    const releaseRoot = await createReleaseFixture(fixture);
    const theme = path.join(releaseRoot, 'app', 'arcane', 'css', 'theme.css');
    const displacedTheme = path.join(fixture, 'displaced-theme.css');
    let replaced = false;
    const raceFs = protectedFixtureFs(fixture, {
      beforeReadSync(fd) {
        if (replaced) return;
        let descriptorTarget = '';
        try { descriptorTarget = fsSync.readlinkSync(`/proc/self/fd/${fd}`); } catch (_) { return; }
        if (path.resolve(descriptorTarget) !== path.resolve(theme)) return;
        replaced = true;
        fsSync.renameSync(theme, displacedTheme);
        fsSync.copyFileSync(displacedTheme, theme);
      },
    });
    const adapter = createAdapter(fixture, { hostPlatform: 'linux', fs: raceFs });
    const payload = adapter.installPayload(releaseRoot);
    assert.equal(replaced, true, 'the final-file replacement must occur during the protected read');
    assert.equal(payload.releaseReady, false);
    assert.match(payload.releaseProblem, /release file changed while it was being read/i);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('Linux installPayload rejects an intermediate release directory replaced during descriptor verification', {
  skip: process.platform !== 'linux',
}, async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-release-directory-race-'));
  try {
    const releaseRoot = await createReleaseFixture(fixture);
    const cssDirectory = path.join(releaseRoot, 'app', 'arcane', 'css');
    const theme = path.join(cssDirectory, 'theme.css');
    const displacedCss = path.join(fixture, 'displaced-css');
    let replaced = false;
    let themeRead = false;
    const raceFs = protectedFixtureFs(fixture, {
      beforeReadSync(fd) {
        if (replaced || themeRead) return;
        let descriptorTarget = '';
        try { descriptorTarget = fsSync.readlinkSync(`/proc/self/fd/${fd}`); } catch (_) { return; }
        if (path.resolve(descriptorTarget) !== path.resolve(theme)) return;
        themeRead = true;
      },
      afterLstatSync(entryPath) {
        if (replaced || !themeRead || entryPath !== path.resolve(theme)) return;
        replaced = true;
        fsSync.renameSync(cssDirectory, displacedCss);
        fsSync.mkdirSync(cssDirectory);
        fsSync.copyFileSync(path.join(displacedCss, 'theme.css'), theme);
      },
    });
    const adapter = createAdapter(fixture, { hostPlatform: 'linux', fs: raceFs });
    const payload = adapter.installPayload(releaseRoot);
    assert.equal(replaced, true, 'the intermediate-directory replacement must occur during the protected read');
    assert.equal(payload.releaseReady, false);
    assert.match(payload.releaseProblem, /release directory changed (?:while reading|during verification)/i);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('root Linux staging byte-copies a user-owned 0777 release into exact protected metadata', {
  skip: process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0,
}, async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-private-stage-'));
  let stage = null;
  let ownership = null;
  try {
    const releaseRoot = await createReleaseFixture(fixture);
    const theme = path.join(releaseRoot, 'app', 'arcane', 'css', 'theme.css');
    const originalTheme = await fs.readFile(theme);
    const uid = Number(process.env.SUDO_UID) > 0 ? Number(process.env.SUDO_UID) : 12345;
    const gid = Number(process.env.SUDO_GID) > 0 ? Number(process.env.SUDO_GID) : uid;
    await poisonTreeMetadata(releaseRoot, uid, gid);
    const adapter = createAdapter(fixture, { hostPlatform: 'linux' });
    const payload = adapter.installPayload(releaseRoot);
    stage = stagePathFor(adapter);
    await fs.mkdir(stage, { recursive: false, mode: 0o700 });
    await adapter.prepareInstallStage(stage);
    ownership = adapter.captureInstallStageOwnership(stage);
    await adapter.materializeInstallStage(stage, payload);
    await adapter.writeLaunchers(stage, payload);
    await adapter.finalizeInstallStage(stage, payload);
    assert.equal(adapter.verifyStagedInstallation(stage, false).verified, true);
    await assertCanonicalInstalledTree(stage);
    const sourceThemeStat = await fs.lstat(theme);
    assert.equal(sourceThemeStat.uid, uid);
    assert.equal(sourceThemeStat.gid, gid);
    assert.equal(sourceThemeStat.mode & 0o7777, 0o777);
    assert.deepEqual(await fs.readFile(theme), originalTheme);
    await adapter.cleanupInstallStage(ownership, stage);
    stage = null;
  } finally {
    if (stage && ownership && fsSync.existsSync(stage)) await createAdapter(fixture).cleanupInstallStage(ownership, stage).catch(() => {});
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('root Linux finalization rejects a hardlink injection before changing its outside inode', {
  skip: process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0,
}, async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-stage-hardlink-'));
  let stage = null;
  let ownership = null;
  try {
    const releaseRoot = await createReleaseFixture(fixture);
    const adapter = createAdapter(fixture, { hostPlatform: 'linux' });
    const payload = adapter.installPayload(releaseRoot);
    stage = stagePathFor(adapter, 'b');
    await fs.mkdir(stage, { recursive: false, mode: 0o700 });
    await adapter.prepareInstallStage(stage);
    ownership = adapter.captureInstallStageOwnership(stage);
    await adapter.materializeInstallStage(stage, payload);
    await adapter.writeLaunchers(stage, payload);
    const sentinel = path.join(fixture, 'outside-sentinel');
    await fs.writeFile(sentinel, 'sentinel', { mode: 0o600 });
    await fs.link(sentinel, path.join(stage, 'app', 'outside-hardlink'));
    const before = await fs.lstat(sentinel);
    await assert.rejects(adapter.finalizeInstallStage(stage, payload), /non-canonical metadata|inventory/);
    const after = await fs.lstat(sentinel);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode & 0o7777, before.mode & 0o7777);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'sentinel');
    assert.equal((await fs.lstat(stage)).mode & 0o7777, 0o700);
    await adapter.cleanupInstallStage(ownership, stage);
    stage = null;
  } finally {
    if (stage && ownership && fsSync.existsSync(stage)) await createAdapter(fixture).cleanupInstallStage(ownership, stage).catch(() => {});
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('Linux unsigned-local installation is exact, explicit, persistent, and downgrade-safe', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-security-'));
  try {
    const releaseRoot = await createReleaseFixture(fixture);
    const adapter = createAdapter(fixture);
    const evidence = adapter.hostReleaseSecurityEvidence();
    assert.equal(evidence.securityMode, 'unsigned-local-test');
    assert.equal(evidence.publisherTrustSource, null);
    assert.equal(evidence.revocationStatus, null);
    const payload = adapter.installPayload(releaseRoot);
    assert.equal(payload.releaseReady, true);
    assert.equal(payload.securityMode, 'unsigned-local-test');
    assert(payload.integrity.files.some(({ installPath }) => installPath === 'bin/arcane-session'));

    const stage = stagePathFor(adapter);
    await materializeStage(adapter, payload, stage);
    assert.match(await fs.readFile(path.join(stage, 'bin', 'arcane-provisioner'), 'utf8'), /--allow-unsigned-local-release/);
    assert.equal(adapter.hostReleaseSecurityEvidence().securityMode, 'unsigned-local-test', 'status verification must not clear the active installation stage evidence');
    assert.equal(adapter.verifyStagedInstallation(stage, false).verified, true);
    assert.equal(adapter.createPublisherAttestation(stage), null);

    const manifest = {
      name: 'Arcane OS', version: bundle.version, nativeAdapter: 'linux', payloadMode: 'linux-webkitgtk',
      securityMode: 'unsigned-local-test', integrity: installedIntegrity(stage),
    };
    await fs.writeFile(path.join(stage, 'arcane-install.json'), JSON.stringify(manifest));
    await protectTree(stage);
    assert.equal(adapter.verifyStagedInstallation(stage, true).securityMode, 'unsigned-local-test');

    await fs.writeFile(path.join(stage, 'bin', 'arcane-session'), 'tampered');
    assert.throws(() => adapter.verifyStagedInstallation(stage, true), /modified installed content/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('a bare switch without the sanitized host claim cannot unlock or persist unsigned mode', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-security-claim-'));
  try {
    const releaseRoot = await createReleaseFixture(fixture);
    const adapter = createAdapter(fixture, { releaseSecurityModeClaim: '' });
    assert.equal(adapter.hostReleaseSecurityEvidence().securityMode, 'unverified');
    const payload = adapter.installPayload(releaseRoot);
    const stage = stagePathFor(adapter);
    await materializeStage(adapter, payload, stage);
    assert.doesNotMatch(await fs.readFile(path.join(stage, 'bin', 'arcane-provisioner'), 'utf8'), /--allow-unsigned-local-release/);
    assert.throws(() => adapter.verifyStagedInstallation(stage, false), /explicit --allow-unsigned-local-release consent/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('Linux installed-tree verification still rejects unsafe ownership and writable modes', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-linux-security-permissions-'));
  try {
    const releaseRoot = await createReleaseFixture(fixture);
    const protectedAdapter = createAdapter(fixture);
    const payload = protectedAdapter.installPayload(releaseRoot);
    const stage = stagePathFor(protectedAdapter);
    await materializeStage(protectedAdapter, payload, stage);

    const ownershipAdapter = createAdapter(fixture, {
      fs: protectedFixtureFs(fixture, {
        uidFor: (entryPath) => entryPath.endsWith(`${path.sep}app${path.sep}provisioner${path.sep}index.html`) ? 1000 : 0,
      }),
    });
    await ownershipAdapter.prepareInstallStage(stage);
    await ownershipAdapter.writeLaunchers(stage, payload);
    assert.throws(() => ownershipAdapter.verifyStagedInstallation(stage, false), /unprotected installed file/);

    const writableAdapter = createAdapter(fixture, {
      fs: protectedFixtureFs(fixture, {
        modeFor: (entryPath, _stat, baselineMode) => entryPath.endsWith(`${path.sep}app${path.sep}provisioner${path.sep}index.html`)
          ? baselineMode | 0o022
          : baselineMode,
      }),
    });
    await writableAdapter.prepareInstallStage(stage);
    await writableAdapter.writeLaunchers(stage, payload);
    assert.throws(() => writableAdapter.verifyStagedInstallation(stage, false), /unprotected installed file/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
