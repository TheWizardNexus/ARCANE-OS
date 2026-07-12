import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createReleaseManifest, verifyReleaseManifest } from './release-integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = { name: 'Arcane OS Machine Bundle', version: 'test-version' };
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

async function loadAdapter(platform) {
  const source = await fsp.readFile(path.join(root, 'src', 'native', `${platform}.cjs`), 'utf8');
  const functionName = platform === 'windows' ? 'createWindowsNativeAdapter' : 'createLinuxNativeAdapter';
  const sandbox = {
    process: {
      env: platform === 'windows' ? { SystemRoot: 'C:\\Windows' } : {},
      arch: 'x64',
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${source}\nglobalThis.createAdapter=${functionName};`, sandbox, { filename: `${platform}.cjs` });
  return sandbox.createAdapter({
    bundleVersion: bundle.version,
    crypto,
    fs,
    fsp,
    path,
    production: true,
    simulate: false,
    spawnSync() { return { status: 1, stdout: '', stderr: '' }; },
  });
}

async function createFixture(platform) {
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `arcane-release-${platform}-`));
  const dist = path.join(fixtureRoot, 'dist');
  await fsp.mkdir(path.join(dist, 'app', 'shared'), { recursive: true });
  await fsp.mkdir(path.join(dist, 'app', 'provisioner'), { recursive: true });
  await fsp.mkdir(path.join(dist, 'app', 'shell'), { recursive: true });
  for (const name of platformFiles[platform]) await fsp.writeFile(path.join(dist, name), `fixture:${platform}:${name}`);
  await fsp.writeFile(path.join(dist, 'arcane-bundle.json'), JSON.stringify(bundle));
  await fsp.writeFile(path.join(dist, 'app', 'shared', 'arcane-api.js'), 'globalThis.Arcane={};');
  await fsp.writeFile(path.join(dist, 'app', 'shared', 'arcane-sigil.svg'), '<svg/>');
  await fsp.writeFile(path.join(dist, 'app', 'shared', 'arcane-sigil-512.png'), 'png');
  await fsp.writeFile(path.join(dist, 'app', 'shared', 'arcane-sigil.ico'), 'ico');
  await fsp.writeFile(path.join(dist, 'app', 'provisioner', 'index.html'), '<h1>Provisioner</h1>');
  await fsp.writeFile(path.join(dist, 'app', 'provisioner', 'manifest.webmanifest'), '{}');
  await fsp.writeFile(path.join(dist, 'app', 'shell', 'index.html'), '<h1>Shell</h1>');
  await fsp.writeFile(path.join(dist, 'app', 'shell', 'manifest.webmanifest'), '{}');
  const manifest = await createReleaseManifest({
    dist,
    bundle,
    platform,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await fsp.writeFile(path.join(dist, 'arcane-release.json'), JSON.stringify(manifest, null, 2));
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
    assert.equal(payload.releaseReady, true);
    assert.equal(payload.verified, true);
    assert.equal(payload.integrity.schemaVersion, 2);
    assert.equal(payload.integrity.files.length, manifest.files.length);
    assert(payload.integrity.files.some((entry) => entry.installPath === 'app/shared/arcane-api.js'));
    assert(payload.integrity.files.some((entry) => entry.installPath === 'bin/ArcaneCore' + (platform === 'windows' ? '.exe' : '')));
    if (platform === 'windows') {
      assert(payload.integrity.files.some((entry) => entry.installPath === 'bin/ArcanePipeGuard.exe'));
      assert(payload.files.some((entry) => entry.destinationName === 'ArcanePipeGuard.exe'));
    }
    assert.equal(payload.bundleManifestSource, path.join(dist, 'arcane-bundle.json'));

    const shell = path.join(dist, 'app', 'shell', 'index.html');
    const originalShell = await fsp.readFile(shell);
    await fsp.writeFile(shell, Buffer.alloc(originalShell.length, 0x78));
    payload = adapter.installPayload(fixtureRoot);
    assert.equal(payload.releaseReady, false);
    assert.match(payload.releaseProblem, /does not match the release manifest SHA-256/i);

    await fsp.writeFile(shell, originalShell);
    await fsp.writeFile(path.join(dist, 'app', 'shared', 'unlisted.js'), 'unexpected');
    payload = adapter.installPayload(fixtureRoot);
    assert.equal(payload.releaseReady, false);
    assert.match(payload.releaseProblem, /inventory does not exactly match/i);
    await fsp.rm(path.join(dist, 'app', 'shared', 'unlisted.js'));

    const unsafeManifest = structuredClone(manifest);
    unsafeManifest.files[0].path = '../outside';
    await fsp.writeFile(path.join(dist, 'arcane-release.json'), JSON.stringify(unsafeManifest));
    payload = adapter.installPayload(fixtureRoot);
    assert.equal(payload.releaseReady, false);
    assert.match(payload.releaseProblem, /unsafe path/i);
  } finally {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  }
}

console.log('Arcane release integrity smoke test passed.');
