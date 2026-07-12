import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APP_CONTENT_MANIFEST,
  APP_PACKAGE_MANIFEST,
  createInstalledAppCatalog,
  verifyAppContentManifest,
  writeAppContentManifest,
} from './app-catalog.mjs';
import { loadAppRegistry } from './app-packager-lib.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('target content manifest is deterministic, exact, and excludes its wrapper and manifests', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-app-content-'));
  try {
    await fs.mkdir(path.join(fixture, 'app/boss/img'), { recursive: true });
    await fs.mkdir(path.join(fixture, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(fixture, 'app/boss/img/icon.png'), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(fixture, 'runtime/arcane-core.cjs'), 'core\n');
    await fs.writeFile(path.join(fixture, 'ArcaneCore.exe'), 'core executable\n');
    await fs.writeFile(path.join(fixture, 'ArcanePipeGuard.exe'), 'guard executable\n');
    await fs.writeFile(path.join(fixture, 'ArcaneApp-boss.exe'), 'wrapper excluded\n');
    await fs.writeFile(path.join(fixture, APP_PACKAGE_MANIFEST), canonical({
      schemaVersion: 1,
      bundleVersion: '0.8.2',
      app: { id: 'boss' },
      files: [],
    }));

    const first = await writeAppContentManifest({ target: fixture, appId: 'boss' });
    const firstText = first.data.toString('utf8');
    const second = await writeAppContentManifest({ target: fixture, appId: 'boss' });
    assert.equal(second.data.toString('utf8'), firstText);
    assert.equal(second.sha256, first.sha256);
    assert.deepEqual(first.manifest.files.map((entry) => entry.path), [
      'ArcaneCore.exe',
      'ArcanePipeGuard.exe',
      'app/boss/img/icon.png',
      'runtime/arcane-core.cjs',
    ]);
    assert(!firstText.includes('ArcaneApp-boss.exe'));
    assert(!firstText.includes(APP_CONTENT_MANIFEST));
    assert(!firstText.includes(APP_PACKAGE_MANIFEST));
    await verifyAppContentManifest({ target: fixture, appId: 'boss', version: '0.8.2' });

    await fs.writeFile(path.join(fixture, 'unlisted.txt'), 'drift\n');
    await assert.rejects(
      () => verifyAppContentManifest({ target: fixture, appId: 'boss', version: '0.8.2' }),
      /does not exactly match the target content/,
    );
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

function packageFixture(configured, bundle) {
  const packageManifest = {
    schemaVersion: 1,
    protocolVersion: bundle.protocolVersion,
    bundleVersion: bundle.version,
    platform: 'windows',
    architecture: 'x64',
    app: {
      id: configured.id,
      displayName: configured.displayName,
      description: configured.description,
      icon: configured.icon,
      order: configured.order,
      type: 'app',
      capabilities: [...configured.capabilities],
    },
    native: {
      launcher: `ArcaneApp-${configured.id}.exe`,
      signatureStatus: 'NotSigned',
    },
    files: [],
  };
  const contentManifest = {
    schemaVersion: 1,
    hashAlgorithm: 'sha256',
    app: { id: configured.id, version: bundle.version },
    files: [{
      path: `app/${configured.id}/${configured.icon}`,
      size: 1,
      sha256: '0'.repeat(64),
    }],
  };
  return {
    appId: configured.id,
    packageManifest,
    packageManifestData: Buffer.from(canonical(packageManifest)),
    contentManifestData: Buffer.from(canonical(contentManifest)),
  };
}

test('installed catalog is deterministic, ID-addressable, and cannot expand capabilities', async () => {
  const [registry, bundle] = await Promise.all([
    loadAppRegistry(bundleRoot),
    fs.readFile(path.join(bundleRoot, 'arcane-bundle.json'), 'utf8').then(JSON.parse),
  ]);
  const boss = packageFixture(registry.apps.boss, bundle);
  const precrisis = packageFixture(registry.apps.precrisis, bundle);
  const first = createInstalledAppCatalog({ bundle, registry, packages: [precrisis, boss] });
  const second = createInstalledAppCatalog({ bundle, registry, packages: [boss, precrisis] });
  assert.equal(canonical(first), canonical(second));
  assert.deepEqual(first.apps.map((app) => app.id), ['boss', 'precrisis']);
  assert(first.apps.every((app) => app.version === '0.8.2'));
  assert(first.apps.every((app) => /^[a-f0-9]{64}$/.test(app.contentManifestSha256)));
  assert(first.apps.every((app) => /^[a-f0-9]{64}$/.test(app.packageManifestSha256)));
  assert.equal(first.apps[0].packageManifestSha256, hash(boss.packageManifestData));
  assert.equal(first.apps[0].icon, 'boss/app/boss/img/boss-libraries-logo-stacked.png');
  const serialized = canonical(first);
  assert(!/launcher|executable|arguments|\bargs\b/i.test(serialized));

  const expanded = clone(boss.packageManifest);
  expanded.app.capabilities.push('users.manage');
  assert.throws(
    () => createInstalledAppCatalog({
      bundle,
      registry,
      packages: [{ ...boss, packageManifest: expanded }, precrisis],
    }),
    /capabilities do not exactly match the non-privileged registry allowlist/,
  );
});

test('native finalization and Windows all-app builds publish the verified runtime projection', async () => {
  const [finalizer, builder] = await Promise.all([
    fs.readFile(path.join(bundleRoot, 'tools/finalize-app-package.mjs'), 'utf8'),
    fs.readFile(path.join(bundleRoot, 'tools/build-app.mjs'), 'utf8'),
  ]);
  assert.match(finalizer, /writeAppContentManifest\(\{ target, appId, launcher \}\)/);
  assert.match(builder, /publishWindowsAppProjection\(\{ bundleRoot, appIds: apps\.map/);
  assert.match(builder, /if \(platform === 'windows'\)/);
});
