import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(bundleRoot, 'src', 'native', 'windows.cjs'), 'utf8');
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-windows-installed-apps-'));
const version = '0.8.2';
const appId = 'boss';
const launcherName = 'ArcaneApp-boss.exe';
const machineExclusions = new Set([
  'arcane-install.json',
  'arcane-machine-content.json',
  'arcane-release.json',
  'bin/ArcaneProvisioner.exe',
  'bin/ArcaneShell.exe',
]);

function canonicalJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function write(relativeRoot, relative, data) {
  const target = path.join(relativeRoot, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}

async function writeJson(relativeRoot, relative, value) {
  await write(relativeRoot, relative, canonicalJson(value));
}

async function inventory(root, exclusions = new Set()) {
  const files = [];
  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = relativeDirectory ? relativeDirectory + '/' + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && !exclusions.has(relative)) {
        const data = await fs.readFile(absolute);
        files.push({ path: relative, size: data.length, sha256: sha256(data) });
      } else if (!entry.isFile()) {
        throw new Error('Unsupported fixture entry: ' + relative);
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
}

function boundBinary(marker, count = 1) {
  const parts = [Buffer.from('MZ-ARCANE-TEST\0', 'utf8')];
  for (let index = 0; index < count; index += 1) {
    parts.push(Buffer.from(marker, 'utf8'), Buffer.from('\0', 'utf8'));
  }
  parts.push(Buffer.from('EOF', 'utf8'));
  return Buffer.concat(parts);
}

async function buildFixture(name, options = {}) {
  const root = path.join(temporaryRoot, name, 'install');
  const stateRoot = path.join(temporaryRoot, name, 'state');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });

  const machineBundle = {
    name: 'Arcane OS Machine Bundle',
    version,
    protocolVersion: 'arcane/1',
    apps: {
      provisioner: { displayName: 'Arcane Provisioner', type: 'provisioner', entry: 'provisioner/index.html', capabilities: [] },
      shell: { displayName: 'Arcane Shell', type: 'shell', entry: 'shell/index.html', capabilities: [] },
    },
  };
  await writeJson(root, 'arcane-bundle.json', machineBundle);
  await write(root, 'app/shared/arcane-api.js', 'globalThis.arcane={};\n');
  await write(root, 'app/provisioner/index.html', '<!doctype html><title>Provisioner</title>\n');
  await write(root, 'app/shell/index.html', '<!doctype html><title>Shell</title>\n');
  await write(root, 'bin/ArcaneCore.exe', 'machine-core');
  await write(root, 'bin/ArcanePipeGuard.exe', 'machine-guard');
  await write(root, 'bin/Microsoft.Web.WebView2.Core.dll', 'webview-core');
  await write(root, 'bin/Microsoft.Web.WebView2.WinForms.dll', 'webview-winforms');
  await write(root, 'bin/WebView2Loader.dll', 'webview-loader');

  const appRoot = path.join(root, 'apps', appId);
  const capabilities = ['system.read'];
  const descriptor = {
    id: appId,
    displayName: 'BOSS',
    description: 'Business operations workspace',
    icon: 'icon.png',
    order: 10,
    type: 'app',
    entry: 'boss/index.html',
    launchEntry: 'boss/index.html',
    capabilities,
    security: {
      contentSecurityPolicy: "default-src 'self'",
      permissionsPolicy: 'camera=()',
      securedDocuments: 1,
      navigationEntries: ['/boss/index.html'],
      verifiedDependencies: 1,
    },
    documentCatalog: null,
  };
  await writeJson(appRoot, 'arcane-bundle.json', {
    name: 'Arcane BOSS Target',
    version,
    protocolVersion: 'arcane/1',
    apps: {
      boss: {
        displayName: descriptor.displayName,
        description: descriptor.description,
        icon: descriptor.icon,
        order: descriptor.order,
        type: descriptor.type,
        entry: descriptor.entry,
        capabilities,
      },
    },
  });
  await write(appRoot, 'app/boss/index.html', '<!doctype html><title>BOSS</title>\n');
  await write(appRoot, 'app/boss/icon.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await write(appRoot, 'ArcaneCore.exe', 'app-core');
  await write(appRoot, 'ArcanePipeGuard.exe', 'app-guard');
  await write(appRoot, 'Microsoft.Web.WebView2.Core.dll', 'app-webview-core');
  await write(appRoot, 'Microsoft.Web.WebView2.WinForms.dll', 'app-webview-winforms');
  await write(appRoot, 'WebView2Loader.dll', 'app-webview-loader');

  const contentManifest = {
    schemaVersion: 1,
    hashAlgorithm: 'sha256',
    app: { id: appId, version },
    files: await inventory(appRoot, new Set(['arcane-app-content.json', 'arcane-app-package.json', launcherName])),
  };
  const contentData = Buffer.from(canonicalJson(contentManifest), 'utf8');
  const contentHash = sha256(contentData);
  await write(appRoot, 'arcane-app-content.json', contentData);
  const targetMarker = 'ARCANE-TARGET-BINDING|1|' + appId + '|' + contentHash;
  await write(appRoot, launcherName, boundBinary(targetMarker, options.targetBindingCount === undefined ? 1 : options.targetBindingCount));

  const packageManifest = {
    schemaVersion: 1,
    protocolVersion: 'arcane/1',
    bundleVersion: version,
    app: descriptor,
    files: await inventory(appRoot, new Set(['arcane-app-package.json'])),
    platform: 'windows',
    architecture: 'x64',
    native: {
      launcher: launcherName,
      core: 'ArcaneCore.exe',
      pipeGuard: 'ArcanePipeGuard.exe',
      renderer: 'WebView2',
      signatureStatus: options.signatureStatus || 'Valid',
      signatureRequiredForDistribution: true,
    },
  };
  const packageData = Buffer.from(canonicalJson(packageManifest), 'utf8');
  await write(appRoot, 'arcane-app-package.json', packageData);

  const catalog = {
    schemaVersion: 1,
    protocolVersion: 'arcane/1',
    bundleVersion: version,
    apps: [{
      id: appId,
      displayName: descriptor.displayName,
      description: descriptor.description,
      icon: 'boss/app/boss/icon.png',
      order: descriptor.order,
      version,
      capabilities,
      contentManifestSha256: contentHash,
      packageManifestSha256: sha256(packageData),
    }],
  };
  await writeJson(root, 'apps/catalog.json', catalog);

  const machineManifest = {
    schemaVersion: 1,
    hashAlgorithm: 'sha256',
    release: { name: machineBundle.name, version, platform: 'windows', architecture: 'x64' },
    files: await inventory(root, machineExclusions),
  };
  const machineData = Buffer.from(canonicalJson(machineManifest), 'utf8');
  const machineHash = sha256(machineData);
  await write(root, 'arcane-machine-content.json', machineData);
  const machineMarker = 'ARCANE-MACHINE-BINDING|1|' + version + '|' + machineHash;
  const machineBindingCount = options.machineBindingCount === undefined ? 1 : options.machineBindingCount;
  await write(root, 'bin/ArcaneShell.exe', boundBinary(machineMarker, machineBindingCount));
  await write(root, 'bin/ArcaneProvisioner.exe', boundBinary(machineMarker, machineBindingCount));

  const releaseManifest = {
    schemaVersion: 2,
    name: machineBundle.name,
    version,
    platform: 'windows',
    architecture: 'x64',
    hashAlgorithm: 'sha256',
    createdAt: '2026-07-12T00:00:00.000Z',
    files: await inventory(root, new Set(['arcane-release.json', 'arcane-install.json'])),
  };
  await writeJson(root, 'arcane-release.json', releaseManifest);
  await writeJson(root, 'arcane-install.json', {
    name: 'Arcane OS',
    version,
    integrity: {
      schemaVersion: 2,
      hashAlgorithm: 'sha256',
      scope: 'installed-tree',
      files: await inventory(root, new Set(['arcane-install.json'])),
    },
  });
  return { root, stateRoot, appRoot, contentHash, machineHash };
}

const sandbox = {
  Buffer,
  console,
  process: {
    arch: 'x64',
    pid: process.pid,
    env: {},
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source + '\nglobalThis.createAdapter=createWindowsNativeAdapter;', sandbox, { filename: 'windows.cjs' });

function signatureRecords(files, mode) {
  return files.map((file, index) => {
    if (mode === 'unsigned') return { path: file, status: 'NotSigned', thumbprint: null, timestamped: false };
    if (mode === 'mixed') return index === 0
      ? { path: file, status: 'Valid', thumbprint: 'A'.repeat(40), timestamped: true }
      : { path: file, status: 'NotSigned', thumbprint: null, timestamped: false };
    if (mode === 'invalid') return { path: file, status: 'HashMismatch', thumbprint: 'A'.repeat(40), timestamped: true };
    return {
      path: file,
      status: 'Valid',
      thumbprint: mode === 'different' && index === files.length - 1 ? 'B'.repeat(40) : 'A'.repeat(40),
      timestamped: mode !== 'untimestamped' || index !== 0,
    };
  });
}

function createAdapter(fixture, options = {}) {
  const spawnCalls = [];
  sandbox.process.env = {
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    ProgramData: 'C:\\ProgramData',
    USERPROFILE: 'C:\\Users\\arcane',
    USERNAME: 'arcane',
    ARCANE_INSTALL_ROOT: fixture.root,
    ARCANE_STATE_ROOT: fixture.stateRoot,
    ARCANE_ATTACKER_SECRET: 'must-not-propagate',
  };
  const adapter = sandbox.createAdapter({
    simulate: false,
    production: false,
    path: path.win32,
    fs: fsSync,
    fsp: fs,
    crypto,
    os,
    bundleVersion: version,
    allowUnsignedLocalRelease: Boolean(options.allowUnsigned),
    releaseSecurityModeClaim: options.claim || 'publisher-verified',
    reparsePointProbe: options.reparsePointProbe || (() => []),
    installLeaseProtectionProbe: options.installLeaseProtectionProbe || (() => true),
    processIdentityProbe: options.processIdentityProbe || (() => ({ state: 'not-found' })),
    runningInstalledProcesses: options.runningInstalledProcesses,
    authenticodeInspector: (files) => signatureRecords(files, options.signatureMode || 'signed'),
    spawn(executable, args, spawnOptions) {
      const child = new EventEmitter();
      child.unrefCalled = false;
      child.unref = () => { child.unrefCalled = true; };
      spawnCalls.push({ executable, args: [...args], options: spawnOptions, child });
      queueMicrotask(() => {
        if (options.spawnError) child.emit('error', new Error('synthetic spawn error'));
        else child.emit('spawn');
      });
      return child;
    },
    spawnSync() {
      throw new Error('Unexpected native process execution in installed-app fixture.');
    },
    arcaneError(code, message, resolution, status, details) {
      return Object.assign(new Error(message), { code, resolution, status, details });
    },
    ensureDir: (directory) => fs.mkdir(directory, { recursive: true }),
    run: async () => ({ code: 0 }),
    powershell: async () => ({ stdout: 'verified\n' }),
    psQuote(value) {
      return "'" + String(value).replaceAll("'", "''") + "'";
    },
    cleanPowerShellError(value) {
      return String(value || '');
    },
  });
  return { adapter, spawnCalls };
}

async function writeLease(fixture, lease) {
  await writeJson(fixture.stateRoot, 'installation-operation.json', lease);
}

function validLease() {
  return {
    schemaVersion: 1,
    pid: 4242,
    processStartTicks: '638900000000000000',
    nonce: 'a'.repeat(48),
    createdAt: '2026-07-12T00:00:00.000Z',
  };
}

try {
  const signedFixture = await buildFixture('signed');
  const signed = createAdapter(signedFixture);
  assert.equal(signed.adapter.releaseSecurityMode(), 'publisher-verified');
  assert.equal(signed.adapter.installPayload(signedFixture.root).selfHosted, true);
  const listed = await signed.adapter.listInstalledApplications();
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), {
    verified: true,
    securityMode: 'publisher-verified',
    applications: [{
      id: 'boss',
      displayName: 'BOSS',
      description: 'Business operations workspace',
      iconUrl: '/apps/boss/app/boss/icon.png',
      version,
      order: 10,
    }],
  });
  const launched = await signed.adapter.launchInstalledApplication('boss');
  assert.deepEqual(JSON.parse(JSON.stringify(launched)), { id: 'boss', accepted: true });
  assert.equal(signed.spawnCalls.length, 1);

  const busyHost = createAdapter(signedFixture, {
    runningInstalledProcesses: () => [{ processId: 412, relativePath: 'bin/ArcaneShell.exe' }],
  });
  assert.throws(
    () => busyHost.adapter.assertNoRunningInstalledApplications(),
    (error) => error && error.code === 'APPLICATIONS_BUSY'
      && error.details.processes[0].relativePath === 'bin/ArcaneShell.exe',
  );
  assert.equal(signed.spawnCalls[0].executable, path.join(signedFixture.appRoot, launcherName));
  assert.deepEqual(signed.spawnCalls[0].args, []);
  assert.equal(signed.spawnCalls[0].options.cwd, signedFixture.appRoot);
  assert.equal(signed.spawnCalls[0].options.shell, false);
  assert.equal(signed.spawnCalls[0].options.stdio, 'ignore');
  assert.equal(signed.spawnCalls[0].options.env.ARCANE_ATTACKER_SECRET, undefined);
  assert.equal(signed.spawnCalls[0].child.unrefCalled, true);
  await assert.rejects(
    signed.adapter.launchInstalledApplication('missing'),
    (error) => error && error.code === 'APPLICATION_NOT_FOUND',
  );
  assert.equal(signed.spawnCalls.length, 1);

  const spawnFailure = createAdapter(signedFixture, { spawnError: true });
  await assert.rejects(spawnFailure.adapter.launchInstalledApplication('boss'), /synthetic spawn error/);

  const unsignedFixture = await buildFixture('unsigned', { signatureStatus: 'NotSigned' });
  const unsigned = createAdapter(unsignedFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
  });
  const unsignedList = await unsigned.adapter.listInstalledApplications();
  assert.equal(unsignedList.securityMode, 'unsigned-local-test');
  await unsigned.adapter.launchInstalledApplication('boss');
  assert.deepEqual(unsigned.spawnCalls[0].args, ['--allow-unsigned-local-release']);
  await assert.rejects(
    createAdapter(unsignedFixture, { signatureMode: 'unsigned', claim: 'unsigned-local-test' }).adapter.listInstalledApplications(),
    /explicit host-attested local-test mode/,
  );

  for (const mode of ['mixed', 'different', 'invalid', 'untimestamped']) {
    const candidate = createAdapter(signedFixture, { signatureMode: mode });
    await assert.rejects(
      candidate.adapter.listInstalledApplications(),
      (error) => Boolean(error && error.message),
      mode + ' signature set must fail closed',
    );
  }

  for (const [name, fixtureOptions] of [
    ['missing-machine-binding', { machineBindingCount: 0 }],
    ['duplicate-machine-binding', { machineBindingCount: 2 }],
    ['missing-target-binding', { targetBindingCount: 0 }],
    ['duplicate-target-binding', { targetBindingCount: 2 }],
  ]) {
    const fixture = await buildFixture(name, fixtureOptions);
    await assert.rejects(createAdapter(fixture).adapter.listInstalledApplications(), /compiled content binding/);
  }

  const reparse = createAdapter(signedFixture, { reparsePointProbe: () => ['apps/boss'] });
  await assert.rejects(reparse.adapter.listInstalledApplications(), /reparse point/);

  const tamperedFixture = await buildFixture('tampered');
  const tampered = createAdapter(tamperedFixture);
  await tampered.adapter.listInstalledApplications();
  await fs.appendFile(path.join(tamperedFixture.appRoot, 'app', 'boss', 'icon.png'), Buffer.from([0]));
  await assert.rejects(tampered.adapter.launchInstalledApplication('boss'));
  assert.equal(tampered.spawnCalls.length, 0, 'launch must fully reverify before starting a process');

  const activeFixture = await buildFixture('active-lease');
  await writeLease(activeFixture, validLease());
  const active = createAdapter(activeFixture, {
    processIdentityProbe: () => ({ state: 'alive', startTicks: validLease().processStartTicks }),
  });
  await assert.rejects(
    active.adapter.launchInstalledApplication('boss'),
    (error) => error && error.code === 'APPLICATION_INSTALL_BUSY',
  );
  assert.equal(active.spawnCalls.length, 0);

  const staleFixture = await buildFixture('stale-lease');
  await writeLease(staleFixture, validLease());
  const stale = createAdapter(staleFixture, { processIdentityProbe: () => ({ state: 'not-found' }) });
  await stale.adapter.launchInstalledApplication('boss');
  assert.equal(stale.spawnCalls.length, 1, 'a protected stale lease must not block applications forever');

  const reusedFixture = await buildFixture('reused-pid-lease');
  await writeLease(reusedFixture, validLease());
  const reused = createAdapter(reusedFixture, {
    processIdentityProbe: () => ({ state: 'alive', startTicks: '638900000000000001' }),
  });
  await reused.adapter.launchInstalledApplication('boss');
  assert.equal(reused.spawnCalls.length, 1, 'a proven different process identity must make the lease stale');

  const malformedFixture = await buildFixture('malformed-lease');
  await writeJson(malformedFixture.stateRoot, 'installation-operation.json', { pid: 4242 });
  const malformed = createAdapter(malformedFixture);
  await assert.rejects(
    malformed.adapter.launchInstalledApplication('boss'),
    (error) => error && error.code === 'APPLICATION_INSTALL_BUSY',
  );

  const unqueryableFixture = await buildFixture('unqueryable-lease');
  await writeLease(unqueryableFixture, validLease());
  const unqueryable = createAdapter(unqueryableFixture, {
    processIdentityProbe: () => ({ state: 'unqueryable' }),
  });
  await assert.rejects(
    unqueryable.adapter.launchInstalledApplication('boss'),
    (error) => error && error.code === 'APPLICATION_INSTALL_BUSY',
  );

  const unprotectedFixture = await buildFixture('unprotected-lease');
  await writeLease(unprotectedFixture, validLease());
  const unprotected = createAdapter(unprotectedFixture, {
    installLeaseProtectionProbe: () => false,
    processIdentityProbe: () => ({ state: 'not-found' }),
  });
  await assert.rejects(
    unprotected.adapter.launchInstalledApplication('boss'),
    (error) => error && error.code === 'APPLICATION_INSTALL_BUSY',
  );
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log('Arcane Windows installed-app adapter smoke test passed.');
