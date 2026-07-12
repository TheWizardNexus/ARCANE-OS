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
const signerThumbprint = 'A'.repeat(40);
const verifiedAt = new Date().toISOString();
const machineExclusions = new Set([
  'arcane-install.json',
  'arcane-machine-content.json',
  'arcane-release.json',
  'bin/ArcaneProvisioner.exe',
  'bin/ArcaneShell.exe',
]);

function parseCanonicalFixtureVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)[.](0|[1-9]\d*)[.](0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareFixtureVersions(left, right) {
  const a = parseCanonicalFixtureVersion(left);
  const b = parseCanonicalFixtureVersion(right);
  if (!a || !b) throw new Error('invalid fixture version');
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

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

function unsignedPeFixture({ pe32Plus = false, certificateTable = false, malformed = false, directoryCount = 16 } = {}) {
  if (malformed) {
    const truncated = Buffer.alloc(64);
    truncated.writeUInt16LE(0x5a4d, 0);
    truncated.writeInt32LE(0x200, 0x3c);
    return truncated;
  }
  const data = Buffer.alloc(0x240);
  const peOffset = 0x80;
  const optionalOffset = peOffset + 24;
  const directoryOffset = pe32Plus ? 112 : 96;
  data.writeUInt16LE(0x5a4d, 0);
  data.writeInt32LE(peOffset, 0x3c);
  data.writeUInt32LE(0x00004550, peOffset);
  data.writeUInt16LE(0x8664, peOffset + 4);
  data.writeUInt16LE(pe32Plus ? 240 : 224, peOffset + 20);
  data.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, optionalOffset);
  data.writeUInt32LE(directoryCount, optionalOffset + directoryOffset - 4);
  if (certificateTable) {
    data.writeUInt32LE(0x220, optionalOffset + directoryOffset + (4 * 8));
    data.writeUInt32LE(0x20, optionalOffset + directoryOffset + (4 * 8) + 4);
  }
  return data;
}

async function rewriteInstalledExecutablesAsPe(fixture, options = {}) {
  const manifestPath = path.join(fixture.root, 'arcane-install.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const executables = manifest.integrity.files.filter((entry) => /[.]exe$/i.test(entry.path));
  for (let index = 0; index < executables.length; index += 1) {
    const entry = executables[index];
    await fs.writeFile(path.join(fixture.root, ...entry.path.split('/')), unsignedPeFixture({
      pe32Plus: index % 2 === 1,
      certificateTable: options.certificateTableIndex === index,
      malformed: options.malformedIndex === index,
      directoryCount: options.missingDirectoryTableIndex === index ? 0 : 16,
    }));
  }
  manifest.integrity.files = await inventory(fixture.root, new Set(['arcane-install.json']));
  await writeJson(fixture.root, 'arcane-install.json', manifest);
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
  const navigationEntries = options.navigationEntries || ['/boss/index.html'];
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
      securedDocuments: navigationEntries.length,
      navigationEntries,
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
  for (const navigationEntry of navigationEntries) {
    if (navigationEntry === '/boss/index.html' || !navigationEntry.startsWith('/boss/')) continue;
    const relative = navigationEntry.slice('/boss/'.length);
    if (!relative || relative.includes('..') || relative.includes('\\') || relative.includes('%') || relative.includes('?') || relative.includes('#')) continue;
    await write(appRoot, `app/boss/${relative}`, '<!doctype html><title>BOSS nested page</title>\n');
  }
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
  const publisherAttestation = {
    schemaVersion: 1,
    verification: 'wintrust-online-chain-exclude-root-timestamp-v1',
    signerThumbprint,
    verifiedAt,
    trustSource: 'uac-approved-tofu',
    bindings: [
      { kind: 'machine', id: 'machine', binding: machineMarker },
      { kind: 'app', id: appId, binding: targetMarker },
    ],
  };
  await writeJson(root, 'arcane-install.json', {
    name: 'Arcane OS',
    version,
    nativeAdapter: 'windows',
    payloadMode: 'windows-executable',
    platform: { platform: 'windows' },
    ...(options.omitSecurityMode ? {} : {
      securityMode: options.installSecurityMode
        || (options.signatureStatus === 'NotSigned' ? 'unsigned-local-test' : 'publisher-verified'),
    }),
    ...(options.signatureStatus === 'NotSigned' || options.omitAttestation ? {} : { publisherAttestation }),
    integrity: {
      schemaVersion: 2,
      hashAlgorithm: 'sha256',
      scope: 'installed-tree',
      files: await inventory(root, new Set(['arcane-install.json'])),
    },
  });
  return { root, stateRoot, appRoot, contentHash, machineHash, machineMarker, targetMarker, publisherAttestation };
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
  const claimedMode = options.claim || 'publisher-verified';
  const publisherClaims = claimedMode === 'publisher-verified' ? {
    releaseContentBindingClaim: options.contentBindingClaim || fixture.machineMarker,
    releaseSignerThumbprintClaim: options.signerClaim || signerThumbprint,
    releaseVerifiedAtClaim: options.verifiedAtClaim || verifiedAt,
    releaseRevocationStatusClaim: options.revocationStatusClaim || 'online-good',
    releaseTrustSourceClaim: options.trustSourceClaim || 'uac-approved-tofu',
    releaseTimestampVerifiedClaim: options.timestampVerifiedClaim === undefined ? true : options.timestampVerifiedClaim,
  } : {};
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
    appMode: options.appMode || 'shell',
    path: path.win32,
    fs: fsSync,
    fsp: options.fsp || fs,
    crypto,
    os,
    bundleVersion: version,
    compareVersions: compareFixtureVersions,
    parseCanonicalReleaseVersion: parseCanonicalFixtureVersion,
    allowUnsignedLocalRelease: Boolean(options.allowUnsigned),
    releaseSecurityModeClaim: claimedMode,
    ...publisherClaims,
    reparsePointProbe: options.reparsePointProbe || (() => []),
    installLeaseProtectionProbe: options.installLeaseProtectionProbe || (() => true),
    processIdentityProbe: options.processIdentityProbe || (() => ({ state: 'not-found' })),
    runningInstalledProcesses: options.runningInstalledProcesses,
    authenticodeInspector: (files) => {
      if (typeof options.onAuthenticodeInspect === 'function') options.onAuthenticodeInspect([...files]);
      const mode = typeof options.signatureModeForFiles === 'function'
        ? options.signatureModeForFiles([...files])
        : options.signatureMode || 'signed';
      return signatureRecords(files, mode);
    },
    ...(options.useRealPeCertificateTable ? {} : {
      emptyPeCertificateTableProbe: options.emptyPeCertificateTableProbe || ((file) => {
        const mode = typeof options.signatureModeForFiles === 'function'
          ? options.signatureModeForFiles([file])
          : options.signatureMode || 'signed';
        return mode === 'unsigned';
      }),
    }),
    publisherAttestationProbe: options.publisherAttestationProbe || (() => fixture.publisherAttestation),
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

async function writeUniqueLease(fixture, lease) {
  await writeJson(fixture.stateRoot, 'installation-operation-' + lease.nonce + '.json', lease);
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

async function mutateInstallManifest(fixture, mutate) {
  const target = path.join(fixture.root, 'arcane-install.json');
  const manifest = JSON.parse(await fs.readFile(target, 'utf8'));
  mutate(manifest);
  await writeJson(fixture.root, 'arcane-install.json', manifest);
}

async function makePreIntegrityLegacy(fixture, legacyVersion, { removeBoundIdentity = true } = {}) {
  await mutateInstallManifest(fixture, (manifest) => {
    manifest.version = legacyVersion;
    delete manifest.integrity;
    delete manifest.securityMode;
    delete manifest.publisherAttestation;
  });
  if (removeBoundIdentity) {
    await fs.unlink(path.join(fixture.root, 'arcane-bundle.json'));
    await fs.unlink(path.join(fixture.root, 'arcane-release.json'));
  }
}

try {
  const signedFixture = await buildFixture('signed');
  let signedInstalledInspections = 0;
  const signed = createAdapter(signedFixture, { onAuthenticodeInspect: () => { signedInstalledInspections += 1; } });
  assert.equal(signed.adapter.releaseSecurityMode(), 'publisher-verified');
  assert.equal(signed.adapter.installPayload(signedFixture.root).selfHosted, true);
  const listed = await signed.adapter.listInstalledApplications();
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), {
    verified: true,
    securityMode: 'publisher-verified',
    publisherTrustSource: 'uac-approved-tofu',
    revocationStatus: 'online-good',
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
  assert.equal(signedInstalledInspections, 0, 'signed installed verification must not perform an uncontrolled PowerShell trust check');

  const transactionFixture = await buildFixture('attestation-transaction');
  const transactionManifestPath = path.join(transactionFixture.root, 'arcane-install.json');
  const transactionManifest = JSON.parse(await fs.readFile(transactionManifestPath, 'utf8'));
  await fs.unlink(transactionManifestPath);
  const transactionAdapter = createAdapter(transactionFixture).adapter;
  const createdAttestation = transactionAdapter.createPublisherAttestation(transactionFixture.root);
  assert.deepEqual(JSON.parse(JSON.stringify(createdAttestation)), transactionFixture.publisherAttestation);
  for (const mode of ['mixed', 'different', 'invalid', 'untimestamped']) {
    assert.throws(
      () => createAdapter(transactionFixture, { signatureMode: mode }).adapter.createPublisherAttestation(transactionFixture.root),
      (error) => Boolean(error && error.message),
      mode + ' staged signature set must fail closed',
    );
  }
  await writeJson(transactionFixture.root, 'arcane-install.json', { ...transactionManifest, publisherAttestation: createdAttestation });
  assert.equal(transactionAdapter.verifyStagedInstallation(transactionFixture.root, true).securityMode, 'publisher-verified');

  const forgedClaimFixture = await buildFixture('attestation-forged-claim-stage');
  await fs.unlink(path.join(forgedClaimFixture.root, 'arcane-install.json'));
  const forgedClaimAttestation = createAdapter(forgedClaimFixture, {
    revocationStatusClaim: 'cache-good',
    verifiedAtClaim: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
  }).adapter.createPublisherAttestation(forgedClaimFixture.root);
  assert.deepEqual(JSON.parse(JSON.stringify(forgedClaimAttestation)), forgedClaimFixture.publisherAttestation,
    'attestation authority must come from the fresh native probe, not ambient host claims');

  const probeMismatchFixture = await buildFixture('attestation-probe-mismatch');
  await fs.unlink(path.join(probeMismatchFixture.root, 'arcane-install.json'));
  assert.throws(() => createAdapter(probeMismatchFixture, {
    publisherAttestationProbe: () => ({
      ...probeMismatchFixture.publisherAttestation,
      bindings: probeMismatchFixture.publisherAttestation.bindings.map((binding, index) => (
        index === 0 ? { ...binding, binding: 'ARCANE-MACHINE-BINDING|1|0.8.2|' + 'f'.repeat(64) } : binding
      )),
    }),
  }).adapter.createPublisherAttestation(probeMismatchFixture.root), /exact content bindings/);

  const missingAttestationFixture = await buildFixture('missing-attestation', { omitAttestation: true });
  assert.throws(() => createAdapter(missingAttestationFixture).adapter.releaseSecurityMode(), /attestation is missing/);

  const mismatchedBindingFixture = await buildFixture('mismatched-attestation-binding');
  await mutateInstallManifest(mismatchedBindingFixture, (manifest) => {
    manifest.publisherAttestation.bindings[1].binding = manifest.publisherAttestation.bindings[0].binding;
  });
  assert.throws(() => createAdapter(mismatchedBindingFixture).adapter.releaseSecurityMode(), /exact content bindings/);

  const mismatchedSignerFixture = await buildFixture('mismatched-attestation-signer');
  await mutateInstallManifest(mismatchedSignerFixture, (manifest) => {
    manifest.publisherAttestation.signerThumbprint = 'B'.repeat(40);
  });
  assert.throws(() => createAdapter(mismatchedSignerFixture).adapter.releaseSecurityMode(), /identity is invalid/);

  const malformedClaims = createAdapter(signedFixture, { timestampVerifiedClaim: false });
  assert.throws(() => malformedClaims.adapter.releaseSecurityMode(), /malformed publisher verification claims/);

  const staleAttestationFixture = await buildFixture('stale-attestation');
  await mutateInstallManifest(staleAttestationFixture, (manifest) => {
    manifest.publisherAttestation.verifiedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  });
  assert.throws(
    () => createAdapter(staleAttestationFixture, { revocationStatusClaim: 'attested-degraded' }).adapter.releaseSecurityMode(),
    /attestation identity is invalid/,
  );
  assert.equal(createAdapter(staleAttestationFixture, { revocationStatusClaim: 'cache-good' }).adapter.releaseSecurityMode(), 'publisher-verified',
    'attestation age limits degraded startup without invalidating a fresh cache-good WinTrust result');

  const staleProbeFixture = await buildFixture('stale-probe-stage');
  await fs.unlink(path.join(staleProbeFixture.root, 'arcane-install.json'));
  assert.throws(() => createAdapter(staleProbeFixture, {
    publisherAttestationProbe: () => ({
      ...staleProbeFixture.publisherAttestation,
      verifiedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }),
  }).adapter.createPublisherAttestation(staleProbeFixture.root), /attestation identity is invalid/);

  const nestedNavigationFixture = await buildFixture('nested-navigation', {
    navigationEntries: ['/boss/index.html', '/boss/pages/settings/profile.html'],
  });
  const nestedNavigation = await createAdapter(nestedNavigationFixture).adapter.listInstalledApplications();
  assert.equal(nestedNavigation.verified, true);

  const traversingNavigationFixture = await buildFixture('traversing-navigation', {
    navigationEntries: ['/boss/index.html', '/boss/../escape.html'],
  });
  await assert.rejects(
    createAdapter(traversingNavigationFixture).adapter.listInstalledApplications(),
    /security navigation allowlist is invalid/,
  );

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
  assert.equal(unsignedList.publisherTrustSource, null);
  assert.equal(unsignedList.revocationStatus, null);
  const unsignedDowngradeFixture = await buildFixture('unsigned-downgrade-stage', { signatureStatus: 'NotSigned' });
  await fs.unlink(path.join(unsignedDowngradeFixture.root, 'arcane-install.json'));
  assert.throws(
    () => createAdapter(signedFixture, {
      signatureMode: 'unsigned',
      allowUnsigned: true,
      claim: 'unsigned-local-test',
    }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root),
    /refuses to replace a signed, publisher-pinned, or unverifiable installation/,
  );
  const unsignedExistingFixture = await buildFixture('unsigned-existing', { signatureStatus: 'NotSigned' });
  assert.equal(createAdapter(unsignedExistingFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), null,
  'a protected exact prior unsigned-local installation may accept another explicit unsigned-local build');

  const legacySignedFixture = await buildFixture('legacy-signed-no-attestation', {
    omitAttestation: true,
    omitSecurityMode: true,
  });
  assert.throws(() => createAdapter(legacySignedFixture, {
    allowUnsigned: true,
    claim: 'unsigned-local-test',
    signatureModeForFiles: (files) => files.every((file) => file.startsWith(unsignedDowngradeFixture.root)) ? 'unsigned' : 'signed',
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /not provably unsigned|refuses to replace/,
  'a signed legacy installation cannot be downgraded merely because it has no attestation or security-mode field');

  const legacyUnsignedFixture = await buildFixture('legacy-unsigned-no-security-mode', {
    signatureStatus: 'NotSigned',
    omitSecurityMode: true,
  });
  assert.throws(() => createAdapter(legacyUnsignedFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /not declared as unsigned local-test|refuses to replace/,
  'an exact-integrity installation must carry the explicit persisted unsigned-local security mode');

  const unknownSecurityModeFixture = await buildFixture('unknown-installed-security-mode', {
    signatureStatus: 'NotSigned',
    installSecurityMode: 'unknown-mode',
  });
  assert.throws(() => createAdapter(unknownSecurityModeFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
  }).adapter.releaseSecurityMode(), /security-mode metadata is missing or invalid/);

  const unsignedDeclaredPublisherFixture = await buildFixture('unsigned-declared-publisher-files', {
    installSecurityMode: 'unsigned-local-test',
  });
  assert.throws(() => createAdapter(unsignedDeclaredPublisherFixture).adapter.releaseSecurityMode(),
    /security-mode metadata does not match the native host proof/,
    'an unsigned-local top-level declaration cannot be reinterpreted as a publisher-verified installation');

  const preIntegrityLegacyFixture = await buildFixture('pre-integrity-legacy-unsigned', { signatureStatus: 'NotSigned' });
  await makePreIntegrityLegacy(preIntegrityLegacyFixture, '0.7.0');
  assert.equal(createAdapter(preIntegrityLegacyFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), null,
  'an older pre-integrity installation may enter the bounded migration path only after every actual executable is proven unsigned');

  const preIntegritySignedFixture = await buildFixture('pre-integrity-legacy-signed');
  await makePreIntegrityLegacy(preIntegritySignedFixture, '0.7.0');
  assert.throws(() => createAdapter(preIntegritySignedFixture, {
    allowUnsigned: true,
    claim: 'unsigned-local-test',
    signatureModeForFiles: (files) => files.every((file) => file.startsWith(unsignedDowngradeFixture.root)) ? 'unsigned' : 'signed',
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /not provably unsigned|refuses to replace/,
  'an actually signed older pre-integrity installation cannot be downgraded to unsigned local-test');

  for (const [name, legacyVersion] of [['equal', version], ['newer', '0.9.0']]) {
    const fixture = await buildFixture(`pre-integrity-${name}`, { signatureStatus: 'NotSigned' });
    await makePreIntegrityLegacy(fixture, legacyVersion);
    assert.throws(() => createAdapter(fixture, {
      signatureMode: 'unsigned',
      allowUnsigned: true,
      claim: 'unsigned-local-test',
    }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /older pre-integrity|refuses to replace/);
  }

  for (const invalidVersion of ['garbage', 'v0.7.0', '0.7.0-extra', '0.7.0.1', '00.7.0']) {
    const fixture = await buildFixture(`pre-integrity-invalid-${invalidVersion.replace(/[^a-z0-9]+/gi, '-')}`, { signatureStatus: 'NotSigned' });
    await makePreIntegrityLegacy(fixture, invalidVersion);
    assert.throws(() => createAdapter(fixture, {
      signatureMode: 'unsigned',
      allowUnsigned: true,
      claim: 'unsigned-local-test',
    }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /integrity metadata is missing or invalid|refuses to replace/,
    `legacy version ${invalidVersion} must not enter the unsigned migration path`);
  }

  const wrongLegacyProductFixture = await buildFixture('pre-integrity-wrong-product', { signatureStatus: 'NotSigned' });
  await makePreIntegrityLegacy(wrongLegacyProductFixture, '0.7.0');
  await mutateInstallManifest(wrongLegacyProductFixture, (manifest) => { manifest.name = 'Not Arcane OS'; });
  assert.throws(() => createAdapter(wrongLegacyProductFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /canonical Arcane product identity|refuses to replace/);

  const mismatchedLegacyIdentityFixture = await buildFixture('pre-integrity-mismatched-bound-identity', { signatureStatus: 'NotSigned' });
  await makePreIntegrityLegacy(mismatchedLegacyIdentityFixture, '0.7.0', { removeBoundIdentity: false });
  assert.throws(() => createAdapter(mismatchedLegacyIdentityFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /versions do not match|refuses to replace/);

  const malformedUnsignedFixture = await buildFixture('legacy-malformed-certificate-table', {
    signatureStatus: 'NotSigned',
    omitSecurityMode: true,
  });
  assert.throws(() => createAdapter(malformedUnsignedFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
    emptyPeCertificateTableProbe: () => false,
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /not provably unsigned|refuses to replace/,
  'NotSigned without an empty PE certificate table is not affirmative unsigned evidence');

  const realPeUnsignedFixture = await buildFixture('real-pe-empty-certificate-tables', { signatureStatus: 'NotSigned' });
  await rewriteInstalledExecutablesAsPe(realPeUnsignedFixture);
  assert.equal(createAdapter(realPeUnsignedFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
    useRealPeCertificateTable: true,
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), null,
  'the production PE32 and PE32+ parser must affirm genuinely empty certificate tables');

  const realPeSignedTableFixture = await buildFixture('real-pe-present-certificate-table', { signatureStatus: 'NotSigned' });
  await rewriteInstalledExecutablesAsPe(realPeSignedTableFixture, { certificateTableIndex: 0 });
  assert.throws(() => createAdapter(realPeSignedTableFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
    useRealPeCertificateTable: true,
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /not provably unsigned|refuses to replace/);

  const realPeMalformedFixture = await buildFixture('real-pe-malformed-header', { signatureStatus: 'NotSigned' });
  await rewriteInstalledExecutablesAsPe(realPeMalformedFixture, { malformedIndex: 0 });
  assert.throws(() => createAdapter(realPeMalformedFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
    useRealPeCertificateTable: true,
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /not provably unsigned|refuses to replace/);

  const realPeMissingDirectoryFixture = await buildFixture('real-pe-missing-directory-table', { signatureStatus: 'NotSigned' });
  await rewriteInstalledExecutablesAsPe(realPeMissingDirectoryFixture, { missingDirectoryTableIndex: 0 });
  assert.throws(() => createAdapter(realPeMissingDirectoryFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
    useRealPeCertificateTable: true,
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /not provably unsigned|refuses to replace/,
  'a PE image that does not declare the security data-directory slot is not affirmative unsigned evidence');

  const declaredSignedFixture = await buildFixture('declared-signed-without-attestation', { omitAttestation: true });
  assert.throws(() => createAdapter(declaredSignedFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root), /not declared as unsigned local-test|refuses to replace/);

  const missingManifestFixture = await buildFixture('unsigned-existing-missing-manifest', { signatureStatus: 'NotSigned' });
  await fs.unlink(path.join(missingManifestFixture.root, 'arcane-install.json'));
  assert.throws(() => createAdapter(missingManifestFixture, {
    signatureMode: 'unsigned',
    allowUnsigned: true,
    claim: 'unsigned-local-test',
  }).adapter.createPublisherAttestation(unsignedDowngradeFixture.root));

  const mismatchedDeclaredModeFixture = await buildFixture('mismatched-declared-security-mode');
  await mutateInstallManifest(mismatchedDeclaredModeFixture, (manifest) => { manifest.securityMode = 'unsigned-local-test'; });
  assert.throws(() => createAdapter(mismatchedDeclaredModeFixture).adapter.releaseSecurityMode(), /security-mode metadata does not match/);
  await unsigned.adapter.launchInstalledApplication('boss');
  assert.deepEqual(unsigned.spawnCalls[0].args, ['--allow-unsigned-local-release']);
  await assert.rejects(
    createAdapter(unsignedFixture, { signatureMode: 'unsigned', claim: 'unsigned-local-test' }).adapter.listInstalledApplications(),
    /unsigned local-test|host-attested local-test/,
  );

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
  await assert.rejects(
    stale.adapter.acquireInstallLease({}),
    (error) => error && error.code === 'INSTALL_BUSY' && error.details && error.details.legacyRecoveryRequired === true,
    'a stale legacy lease must fail closed instead of racing an older Provisioner during recovery',
  );

  const leaseRaceFixture = await buildFixture('stale-lease-race');
  await writeUniqueLease(leaseRaceFixture, validLease());
  let candidateWrites = 0;
  let releaseCandidateWrites;
  const candidateWriteBarrier = new Promise((resolve) => { releaseCandidateWrites = resolve; });
  const gatedFsp = new Proxy(fs, {
    get(target, property) {
      if (property !== 'writeFile') {
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...writeArgs) => {
        if (path.basename(String(writeArgs[0])).startsWith('installation-operation-')) {
          candidateWrites += 1;
          if (candidateWrites === 2) releaseCandidateWrites();
          await candidateWriteBarrier;
        }
        return fs.writeFile(...writeArgs);
      };
    },
  });
  const currentTicks = '638900000000000111';
  const leaseIdentity = (pid) => Number(pid) === process.pid
    ? { state: 'alive', startTicks: currentTicks }
    : { state: 'not-found' };
  const leaseRacerOne = createAdapter(leaseRaceFixture, { fsp: gatedFsp, processIdentityProbe: leaseIdentity });
  const leaseRacerTwo = createAdapter(leaseRaceFixture, { fsp: gatedFsp, processIdentityProbe: leaseIdentity });
  const raced = await Promise.allSettled([
    leaseRacerOne.adapter.acquireInstallLease({}),
    leaseRacerTwo.adapter.acquireInstallLease({}),
  ]);
  const acquired = raced.filter((result) => result.status === 'fulfilled');
  assert(acquired.length <= 1, 'concurrent stale recovery must never grant two installation leases');
  for (const result of acquired) await leaseRacerOne.adapter.releaseInstallLease(result.value);
  const retryLease = await leaseRacerOne.adapter.acquireInstallLease({});
  const legacyLeasePath = path.join(leaseRaceFixture.stateRoot, 'installation-operation.json');
  const legacyLease = JSON.parse(await fs.readFile(legacyLeasePath, 'utf8'));
  assert.equal(legacyLease.nonce, retryLease.nonce, 'new leases must publish the legacy fixed-path exclusion beacon');
  await assert.rejects(
    fs.writeFile(legacyLeasePath, canonicalJson(validLease()), { encoding: 'utf8', flag: 'wx' }),
    (error) => error && error.code === 'EEXIST',
    'an older Provisioner must observe the active fixed-path exclusion beacon',
  );
  await leaseRacerOne.adapter.releaseInstallLease(retryLease);
  await assert.rejects(fs.access(legacyLeasePath), (error) => error && error.code === 'ENOENT');

  const cleanupFailureFixture = await buildFixture('stale-cleanup-failure');
  const staleCleanupLease = validLease();
  await writeUniqueLease(cleanupFailureFixture, staleCleanupLease);
  const staleCleanupName = 'installation-operation-' + staleCleanupLease.nonce + '.json';
  const cleanupFailureFsp = new Proxy(fs, {
    get(target, property) {
      const value = target[property];
      if (property !== 'unlink') return typeof value === 'function' ? value.bind(target) : value;
      return async (targetPath) => {
        if (path.basename(String(targetPath)) === staleCleanupName) {
          const error = new Error('injected stale cleanup failure');
          error.code = 'EACCES';
          throw error;
        }
        return fs.unlink(targetPath);
      };
    },
  });
  const cleanupFailure = createAdapter(cleanupFailureFixture, {
    fsp: cleanupFailureFsp,
    processIdentityProbe: leaseIdentity,
  });
  await assert.rejects(cleanupFailure.adapter.acquireInstallLease({}), /injected stale cleanup failure/);
  const remainingLeaseNames = (await fs.readdir(cleanupFailureFixture.stateRoot))
    .filter((name) => name.startsWith('installation-operation'));
  assert.deepEqual(remainingLeaseNames, [staleCleanupName], 'failed stale cleanup must release its newly created active lease');

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
