import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { writeAppContentManifest } from './app-catalog.mjs';
import { writeMachineContentManifest } from './machine-content.mjs';
import { createReleaseManifest, verifyReleaseManifest } from './release-integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = { name: 'Arcane OS Machine Bundle', version: 'test-version', protocolVersion: 'arcane/1' };
const platformFiles = {
  windows: [
    'ArcaneShell.exe',
    'ArcaneProvisioner.exe',
    'ArcaneCore.exe',
    'ArcanePipeGuard.exe',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
  ],
  linux: ['ArcaneShell', 'ArcaneProvisioner', 'ArcaneCore'],
};

const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

async function fileInventory(directory, excluded = new Set()) {
  const files = [];
  async function visit(current, relativeDirectory = '') {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Fixture contains symbolic link ${relative}.`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && !excluded.has(relative)) {
        const data = await fsp.readFile(absolute);
        files.push({ path: relative, size: data.length, sha256: sha256(data) });
      } else if (!entry.isFile()) throw new Error(`Fixture contains unsupported entry ${relative}.`);
    }
  }
  await visit(directory);
  return files.sort((left, right) => compareText(left.path, right.path));
}

async function loadAdapter(platform, options = {}) {
  const source = await fsp.readFile(path.join(root, 'src', 'native', `${platform}.cjs`), 'utf8');
  const functionName = platform === 'windows' ? 'createWindowsNativeAdapter' : 'createLinuxNativeAdapter';
  const sandbox = {
    Buffer,
    process: {
      env: platform === 'windows' ? { SystemRoot: 'C:\\Windows' } : {},
      arch: 'x64',
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${source}\nglobalThis.createAdapter=${functionName};`, sandbox, { filename: `${platform}.cjs` });
  const allowUnsigned = platform === 'windows' && options.allowUnsigned !== false;
  return sandbox.createAdapter({
    allowUnsignedLocalRelease: allowUnsigned,
    releaseSecurityModeClaim: allowUnsigned ? 'unsigned-local-test' : '',
    authenticodeInspector(files) {
      return files.map((file) => ({ path: file, status: 'NotSigned', thumbprint: null, subject: null, timestamped: false }));
    },
    reparsePointProbe() { return []; },
    bundleVersion: bundle.version,
    crypto,
    fs,
    fsp,
    os,
    path,
    production: platform !== 'windows',
    simulate: false,
    spawnSync() { return { status: 1, stdout: '', stderr: '' }; },
  });
}

async function writeOuterRelease(dist, platform) {
  const manifest = await createReleaseManifest({
    dist,
    bundle,
    platform,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await fsp.writeFile(path.join(dist, 'arcane-release.json'), canonicalJson(manifest));
  return manifest;
}

async function createWindowsAppPackage(dist) {
  const id = 'fixture';
  const appRoot = path.join(dist, 'apps', id);
  const launcher = `ArcaneApp-${id}.exe`;
  const displayName = 'Fixture App';
  const description = 'Fixture application for release integrity verification.';
  const icon = 'icon.png';
  const capabilities = ['system.read'];
  await fsp.mkdir(path.join(appRoot, 'app', id), { recursive: true });
  for (const name of ['ArcaneCore.exe', 'ArcanePipeGuard.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']) {
    await fsp.writeFile(path.join(appRoot, name), `fixture:windows:${id}:${name}`);
  }
  await fsp.writeFile(path.join(appRoot, 'app', id, 'index.html'), '<h1>Fixture app</h1>');
  await fsp.writeFile(path.join(appRoot, 'app', id, icon), 'fixture-icon');
  await fsp.writeFile(path.join(appRoot, 'arcane-bundle.json'), JSON.stringify({
    version: bundle.version,
    protocolVersion: bundle.protocolVersion,
    apps: {
      [id]: { displayName, description, icon, order: 1, type: 'app', entry: `${id}/index.html`, capabilities },
    },
  }, null, 2));

  const packageManifestPath = path.join(appRoot, 'arcane-app-package.json');
  const appDescriptor = {
    id,
    displayName,
    description,
    icon,
    order: 1,
    type: 'app',
    entry: `${id}/index.html`,
    launchEntry: `${id}/index.html`,
    capabilities,
    security: {
      contentSecurityPolicy: "default-src 'self'",
      permissionsPolicy: 'microphone=()',
      securedDocuments: 1,
      navigationEntries: [`/${id}/index.html`],
      verifiedDependencies: 1,
    },
    documentCatalog: null,
  };
  const nativeDescriptor = {
    launcher,
    core: 'ArcaneCore.exe',
    pipeGuard: 'ArcanePipeGuard.exe',
    renderer: 'WebView2',
    signatureStatus: 'NotSigned',
    signatureRequiredForDistribution: true,
  };
  await fsp.writeFile(packageManifestPath, canonicalJson({
    schemaVersion: 1,
    protocolVersion: bundle.protocolVersion,
    bundleVersion: bundle.version,
    app: appDescriptor,
    files: [],
    platform: 'windows',
    architecture: 'x64',
    native: nativeDescriptor,
  }));
  const content = await writeAppContentManifest({ target: appRoot, appId: id, launcher });
  await fsp.writeFile(path.join(appRoot, launcher), `fixture-wrapper\nARCANE-TARGET-BINDING|1|${id}|${content.sha256}\n`);
  const packageManifest = {
    schemaVersion: 1,
    protocolVersion: bundle.protocolVersion,
    bundleVersion: bundle.version,
    app: appDescriptor,
    files: await fileInventory(appRoot, new Set(['arcane-app-package.json'])),
    platform: 'windows',
    architecture: 'x64',
    native: nativeDescriptor,
  };
  const packageData = Buffer.from(canonicalJson(packageManifest));
  await fsp.writeFile(packageManifestPath, packageData);
  return {
    id,
    contentSha256: content.sha256,
    packageSha256: sha256(packageData),
    displayName,
    description,
    icon,
    capabilities,
  };
}

async function createFixture(platform) {
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `arcane-release-${platform}-`));
  const dist = path.join(fixtureRoot, 'dist');
  await fsp.mkdir(path.join(dist, 'app', 'shared'), { recursive: true });
  await fsp.mkdir(path.join(dist, 'app', 'provisioner'), { recursive: true });
  await fsp.mkdir(path.join(dist, 'app', 'shell'), { recursive: true });
  const platformDirectory = platform === 'windows' ? path.join(dist, 'bin') : dist;
  await fsp.mkdir(platformDirectory, { recursive: true });
  for (const name of platformFiles[platform]) {
    if (platform === 'windows' && ['ArcaneShell.exe', 'ArcaneProvisioner.exe'].includes(name)) continue;
    await fsp.writeFile(path.join(platformDirectory, name), `fixture:${platform}:${name}`);
  }
  await fsp.writeFile(path.join(dist, 'arcane-bundle.json'), canonicalJson(bundle));
  await fsp.writeFile(path.join(dist, 'app', 'shared', 'arcane-api.js'), 'globalThis.Arcane={};');
  await fsp.writeFile(path.join(dist, 'app', 'shared', 'arcane-sigil.svg'), '<svg/>');
  await fsp.writeFile(path.join(dist, 'app', 'shared', 'arcane-sigil-512.png'), 'png');
  await fsp.writeFile(path.join(dist, 'app', 'shared', 'arcane-sigil.ico'), 'ico');
  await fsp.writeFile(path.join(dist, 'app', 'provisioner', 'index.html'), '<h1>Provisioner</h1>');
  await fsp.writeFile(path.join(dist, 'app', 'provisioner', 'manifest.webmanifest'), '{}');
  await fsp.writeFile(path.join(dist, 'app', 'shell', 'index.html'), '<h1>Shell</h1>');
  await fsp.writeFile(path.join(dist, 'app', 'shell', 'manifest.webmanifest'), '{}');

  if (platform === 'windows') {
    const app = await createWindowsAppPackage(dist);
    await fsp.writeFile(path.join(dist, 'apps', 'catalog.json'), canonicalJson({
      schemaVersion: 1,
      protocolVersion: bundle.protocolVersion,
      bundleVersion: bundle.version,
      apps: [{
        id: app.id,
        displayName: app.displayName,
        description: app.description,
        icon: `${app.id}/app/${app.id}/${app.icon}`,
        order: 1,
        version: bundle.version,
        capabilities: app.capabilities,
        contentManifestSha256: app.contentSha256,
        packageManifestSha256: app.packageSha256,
      }],
    }));
    const machine = await writeMachineContentManifest({ releaseRoot: dist, bundle });
    const binding = `ARCANE-MACHINE-BINDING|1|${bundle.version}|${machine.sha256}`;
    await fsp.writeFile(path.join(dist, 'bin', 'ArcaneShell.exe'), `fixture-shell\n${binding}\n`);
    await fsp.writeFile(path.join(dist, 'bin', 'ArcaneProvisioner.exe'), `fixture-provisioner\n${binding}\n`);
  }
  const manifest = await writeOuterRelease(dist, platform);
  return { fixtureRoot, dist, manifest };
}

for (const platform of ['windows', 'linux']) {
  const { fixtureRoot, dist, manifest } = await createFixture(platform);
  try {
    const verified = await verifyReleaseManifest({ dist, manifest, platform, version: bundle.version });
    assert.equal(verified.length, manifest.files.length);
    assert(manifest.files.some((entry) => entry.path === 'app/shared/arcane-api.js'));
    assert(manifest.files.some((entry) => entry.path === 'arcane-bundle.json'));

    const adapter = await loadAdapter(platform);
    let payload = adapter.installPayload(fixtureRoot);
    assert.equal(payload.releaseReady, true, payload.releaseProblem || payload.description);
    assert.equal(payload.verified, true, payload.releaseProblem || payload.description);
    assert.equal(payload.integrity.schemaVersion, 2);
    assert.equal(payload.integrity.files.length, manifest.files.length + (platform === 'windows' ? 1 : 0));
    assert(payload.integrity.files.some((entry) => entry.installPath === 'app/shared/arcane-api.js'));
    assert(payload.integrity.files.some((entry) => entry.installPath === 'bin/ArcaneCore' + (platform === 'windows' ? '.exe' : '')));
    if (platform === 'windows') {
      assert(payload.integrity.files.some((entry) => entry.installPath === 'bin/ArcanePipeGuard.exe'));
      assert(payload.files.some((entry) => entry.installPath === 'bin/ArcanePipeGuard.exe'));
      assert(payload.files.some((entry) => entry.installPath === 'apps/catalog.json'));
      assert(payload.files.some((entry) => entry.installPath === 'arcane-machine-content.json'));
      assert.equal(payload.securityMode, 'unsigned-local-test');
    } else {
      assert.equal(payload.bundleManifestSource, path.join(dist, 'arcane-bundle.json'));
    }

    if (platform === 'windows') {
      const strictAdapter = await loadAdapter(platform, { allowUnsigned: false });
      const strictPayload = strictAdapter.installPayload(fixtureRoot);
      assert.equal(strictPayload.releaseReady, false, 'unsigned fixtures must require the explicit host-attested local-test mode');
      assert.match(strictPayload.releaseProblem, /explicit host-attested local-test mode/i);

      await fsp.writeFile(path.join(dist, 'unexpected-root.txt'), 'unexpected');
      await assert.rejects(
        () => writeOuterRelease(dist, platform),
        /Windows release root must contain exactly/,
      );
      await fsp.rm(path.join(dist, 'unexpected-root.txt'));
      await fsp.writeFile(path.join(dist, 'bin', 'unexpected.dll'), 'unexpected');
      await assert.rejects(
        () => writeOuterRelease(dist, platform),
        /Windows release bin must contain exactly/,
      );
      await fsp.rm(path.join(dist, 'bin', 'unexpected.dll'));
      await fsp.mkdir(path.join(dist, 'app', 'empty'));
      await assert.rejects(
        () => writeOuterRelease(dist, platform),
        /Release payload cannot contain an empty directory: app\/empty/,
      );
      await fsp.rm(path.join(dist, 'app', 'empty'), { recursive: true });
      await fsp.writeFile(path.join(dist, 'arcane-install.json'), '{}');
      await assert.rejects(
        () => writeOuterRelease(dist, platform),
        /Windows release root must contain exactly/,
      );
      await fsp.rm(path.join(dist, 'arcane-install.json'));

      const catalogPath = path.join(dist, 'apps', 'catalog.json');
      const originalCatalog = await fsp.readFile(catalogPath, 'utf8');
      assert(originalCatalog.includes('Fixture App'));
      await fsp.writeFile(catalogPath, originalCatalog.replace('Fixture App', 'Fixture Alt'));
      await writeOuterRelease(dist, platform);
      payload = adapter.installPayload(fixtureRoot);
      assert.equal(payload.releaseReady, false, 'rewriting only the mutable outer manifest must not authorize a changed app catalog');
      assert.match(payload.releaseProblem, /machine content manifest.*does not exactly match/i);
      await fsp.writeFile(catalogPath, originalCatalog);
      await writeOuterRelease(dist, platform);
      payload = adapter.installPayload(fixtureRoot);
      assert.equal(payload.releaseReady, true, payload.releaseProblem || payload.description);

      const reboundShell = path.join(dist, 'app', 'shell', 'index.html');
      const originalReboundShell = await fsp.readFile(reboundShell);
      await fsp.writeFile(reboundShell, '<h1>Rebound shell payload</h1>');
      const reboundMachine = await writeMachineContentManifest({ releaseRoot: dist, bundle });
      assert.notEqual(reboundMachine.sha256, manifest.files.find((entry) => entry.path === 'arcane-machine-content.json').sha256);
      await writeOuterRelease(dist, platform);
      payload = adapter.installPayload(fixtureRoot);
      assert.equal(payload.releaseReady, false, 'rewritten content manifests must remain bound to the compiled native hosts');
      assert.match(payload.releaseProblem, /compiled content binding/i);
      await fsp.writeFile(reboundShell, originalReboundShell);
      await writeMachineContentManifest({ releaseRoot: dist, bundle });
      await writeOuterRelease(dist, platform);
      payload = adapter.installPayload(fixtureRoot);
      assert.equal(payload.releaseReady, true, payload.releaseProblem || payload.description);
    }

    const shell = path.join(dist, 'app', 'shell', 'index.html');
    const originalShell = await fsp.readFile(shell);
    await fsp.writeFile(shell, Buffer.alloc(originalShell.length, 0x78));
    payload = adapter.installPayload(fixtureRoot);
    assert.equal(payload.releaseReady, false);
    assert.match(payload.releaseProblem, platform === 'windows'
      ? /outer release manifest.*does not exactly match/i
      : /does not match the release manifest SHA-256/i);

    await fsp.writeFile(shell, originalShell);
    await fsp.writeFile(path.join(dist, 'app', 'shared', 'unlisted.js'), 'unexpected');
    payload = adapter.installPayload(fixtureRoot);
    assert.equal(payload.releaseReady, false);
    assert.match(payload.releaseProblem, platform === 'windows'
      ? /outer release manifest.*does not exactly match/i
      : /inventory does not exactly match/i);
    await fsp.rm(path.join(dist, 'app', 'shared', 'unlisted.js'));

    const unsafeManifest = structuredClone(manifest);
    unsafeManifest.files[0].path = '../outside';
    await fsp.writeFile(path.join(dist, 'arcane-release.json'), canonicalJson(unsafeManifest));
    payload = adapter.installPayload(fixtureRoot);
    assert.equal(payload.releaseReady, false);
    assert.match(payload.releaseProblem, /unsafe path|traverses its root/i);
  } finally {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  }
}

console.log('Arcane release integrity smoke test passed.');
