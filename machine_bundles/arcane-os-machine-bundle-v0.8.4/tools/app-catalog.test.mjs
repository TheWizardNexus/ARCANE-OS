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
  publishWindowsAppProjection,
  verifyAppContentManifest,
  verifyWindowsAppProjection,
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('target content manifest is deterministic, exact, and excludes its wrapper and manifests', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-app-content-'));
  try {
    await fs.mkdir(path.join(fixture, 'app/boss/img'), { recursive: true });
    await fs.writeFile(path.join(fixture, 'app/boss/img/icon.png'), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(fixture, 'ArcaneCore.exe'), 'core executable\n');
    await fs.writeFile(path.join(fixture, 'ArcanePipeGuard.exe'), 'guard executable\n');
    await fs.writeFile(path.join(fixture, 'Microsoft.Web.WebView2.Core.dll'), 'core dll\n');
    await fs.writeFile(path.join(fixture, 'Microsoft.Web.WebView2.WinForms.dll'), 'forms dll\n');
    await fs.writeFile(path.join(fixture, 'WebView2Loader.dll'), 'loader dll\n');
    await fs.writeFile(path.join(fixture, 'arcane-bundle.json'), '{}\n');
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
      'Microsoft.Web.WebView2.Core.dll',
      'Microsoft.Web.WebView2.WinForms.dll',
      'WebView2Loader.dll',
      'app/boss/img/icon.png',
      'arcane-bundle.json',
    ]);
    assert(!firstText.includes('ArcaneApp-boss.exe'));
    assert(!firstText.includes(APP_CONTENT_MANIFEST));
    assert(!firstText.includes(APP_PACKAGE_MANIFEST));
    await fs.writeFile(path.join(fixture, 'ArcaneApp-boss.exe'), 'wrapper excluded\n');
    await verifyAppContentManifest({ target: fixture, appId: 'boss', version: '0.8.2' });
    await assert.rejects(
      () => writeAppContentManifest({ target: fixture, appId: 'con' }),
      /app id is invalid or reserved/,
    );

    await fs.rm(path.join(fixture, 'ArcaneApp-boss.exe'));
    await assert.rejects(
      () => verifyAppContentManifest({ target: fixture, appId: 'boss', version: '0.8.2' }),
      /finalized target root contains missing or unexpected entries/,
    );
    await fs.writeFile(path.join(fixture, 'ArcaneApp-boss.exe'), 'wrapper excluded\n');
    const contentData = await fs.readFile(path.join(fixture, APP_CONTENT_MANIFEST));
    await fs.rm(path.join(fixture, APP_CONTENT_MANIFEST));
    await assert.rejects(
      () => verifyAppContentManifest({ target: fixture, appId: 'boss', version: '0.8.2' }),
      /finalized target root contains missing or unexpected entries/,
    );
    await fs.writeFile(path.join(fixture, APP_CONTENT_MANIFEST), contentData);

    await fs.writeFile(path.join(fixture, 'unlisted.txt'), 'drift\n');
    await assert.rejects(
      () => verifyAppContentManifest({ target: fixture, appId: 'boss', version: '0.8.2' }),
      /finalized target root contains missing or unexpected entries/,
    );
    await fs.rm(path.join(fixture, 'unlisted.txt'));

    await fs.mkdir(path.join(fixture, 'app/boss/empty'));
    await assert.rejects(
      () => verifyAppContentManifest({ target: fixture, appId: 'boss', version: '0.8.2' }),
      /package contains empty directory "app\/boss\/empty"/,
    );
    await fs.rm(path.join(fixture, 'app/boss/empty'), { recursive: true });

    await fs.mkdir(path.join(fixture, 'runtime'));
    await fs.writeFile(path.join(fixture, 'runtime/arcane-core.cjs'), 'mutable runtime\n');
    await assert.rejects(
      () => writeAppContentManifest({ target: fixture, appId: 'boss' }),
      /pre-wrapper target root contains missing or unexpected entries/,
    );
    await fs.rm(path.join(fixture, 'runtime'), { recursive: true });
    for (const name of ['start-boss.bat', 'Helper.exe']) {
      await fs.writeFile(path.join(fixture, name), 'unexpected mutable entry\n');
      await assert.rejects(
        () => writeAppContentManifest({ target: fixture, appId: 'boss' }),
        /pre-wrapper target root contains missing or unexpected entries/,
      );
      await fs.rm(path.join(fixture, name));
    }
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

async function nativeInventory(root) {
  const files = [];
  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && relative !== APP_PACKAGE_MANIFEST) {
        const data = await fs.readFile(absolute);
        files.push({ path: relative, size: data.length, sha256: hash(data) });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => compareText(left.path, right.path));
}

async function writeNativeTargetFixture({ fixtureRoot, registry, bundle, appId, marker }) {
  const configured = registry.apps[appId];
  const target = path.join(fixtureRoot, 'dist', 'targets', appId);
  const launcher = `ArcaneApp-${appId}.exe`;
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(path.join(target, 'app', appId, configured.icon)), { recursive: true });
  await fs.writeFile(path.join(target, 'app', appId, configured.icon), marker);
  await fs.writeFile(path.join(target, 'app', appId, 'index.html'), `<html><head></head><body>${marker}</body></html>\n`);
  await fs.writeFile(path.join(target, 'arcane-bundle.json'), canonical(bundle));
  for (const name of [
    'ArcaneCore.exe',
    'ArcanePipeGuard.exe',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
    launcher,
  ]) {
    await fs.writeFile(path.join(target, name), `${name}:${marker}\n`);
  }
  const manifest = {
    schemaVersion: 1,
    protocolVersion: bundle.protocolVersion,
    bundleVersion: bundle.version,
    app: {
      id: appId,
      displayName: configured.displayName,
      description: configured.description,
      icon: configured.icon,
      order: configured.order,
      type: 'app',
      entry: `${appId}/index.html`,
      launchEntry: `${appId}/index.html`,
      capabilities: [...configured.capabilities],
      security: {
        contentSecurityPolicy: "default-src 'none'",
        permissionsPolicy: 'microphone=()',
        securedDocuments: 1,
        navigationEntries: [`/${appId}/index.html`],
        verifiedDependencies: 1,
      },
      documentCatalog: null,
    },
    files: [],
  };
  await fs.writeFile(path.join(target, APP_PACKAGE_MANIFEST), canonical(manifest));
  await writeAppContentManifest({ target, appId, launcher });
  const finalized = {
    ...manifest,
    platform: 'windows',
    architecture: 'x64',
    native: {
      launcher,
      core: 'ArcaneCore.exe',
      pipeGuard: 'ArcanePipeGuard.exe',
      renderer: 'WebView2',
      signatureStatus: 'NotSigned',
      signatureRequiredForDistribution: true,
    },
    files: await nativeInventory(target),
  };
  await fs.writeFile(path.join(target, APP_PACKAGE_MANIFEST), canonical(finalized));
  return target;
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
  assert(first.apps.every((app) => app.version === bundle.version));
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

test('native content binding precedes finalization and Windows all-app builds publish the verified runtime projection', async () => {
  const [contentWriter, finalizer, builder] = await Promise.all([
    fs.readFile(path.join(bundleRoot, 'tools/write-app-content-manifest.mjs'), 'utf8'),
    fs.readFile(path.join(bundleRoot, 'tools/finalize-app-package.mjs'), 'utf8'),
    fs.readFile(path.join(bundleRoot, 'tools/build-app.mjs'), 'utf8'),
  ]);
  assert.match(contentWriter, /writeAppContentManifest\(\{ target, appId, launcher \}\)/);
  assert.match(finalizer, /verifyAppContentManifest/);
  assert.doesNotMatch(finalizer, /writeAppContentManifest/);
  assert.match(builder, /publishWindowsAppProjection\(\{ bundleRoot, appIds: apps\.map/);
  assert.match(builder, /appIds: \[appId\], preserveExistingApps: true/);
  assert.match(builder, /if \(platform === 'windows'\)/);
});

test('a targeted native rebuild preserves every other valid projected app', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-targeted-projection-'));
  try {
    await fs.copyFile(path.join(bundleRoot, 'arcane-apps.json'), path.join(fixtureRoot, 'arcane-apps.json'));
    await fs.copyFile(path.join(bundleRoot, 'arcane-bundle.json'), path.join(fixtureRoot, 'arcane-bundle.json'));
    const [registry, bundle] = await Promise.all([
      loadAppRegistry(fixtureRoot),
      fs.readFile(path.join(fixtureRoot, 'arcane-bundle.json'), 'utf8').then(JSON.parse),
    ]);
    await writeNativeTargetFixture({ fixtureRoot, registry, bundle, appId: 'boss', marker: 'boss-v1' });
    const precrisisTarget = await writeNativeTargetFixture({ fixtureRoot, registry, bundle, appId: 'precrisis', marker: 'precrisis-v1' });
    await publishWindowsAppProjection({ bundleRoot: fixtureRoot, appIds: ['boss', 'precrisis'] });
    await verifyWindowsAppProjection({ bundleRoot: fixtureRoot, appIds: ['boss', 'precrisis'] });

    await fs.appendFile(
      path.join(fixtureRoot, 'dist/apps/boss/app/boss', registry.apps.boss.icon),
      '-stale-selected-app',
    );
    await fs.rm(precrisisTarget, { recursive: true, force: true });
    await writeNativeTargetFixture({ fixtureRoot, registry, bundle, appId: 'boss', marker: 'boss-v2' });
    const published = await publishWindowsAppProjection({
      bundleRoot: fixtureRoot,
      appIds: ['boss'],
      preserveExistingApps: true,
    });

    assert.deepEqual(published.catalog.apps.map((app) => app.id), ['boss', 'precrisis']);
    await verifyWindowsAppProjection({ bundleRoot: fixtureRoot, appIds: ['boss', 'precrisis'] });
    assert.equal(
      await fs.readFile(path.join(fixtureRoot, 'dist/apps/boss/app/boss', registry.apps.boss.icon), 'utf8'),
      'boss-v2',
    );
    assert.equal(
      await fs.readFile(path.join(fixtureRoot, 'dist/apps/precrisis/app/precrisis', registry.apps.precrisis.icon), 'utf8'),
      'precrisis-v1',
    );

    await fs.appendFile(
      path.join(fixtureRoot, 'dist/apps/precrisis/app/precrisis', registry.apps.precrisis.icon),
      '-tampered',
    );
    await writeNativeTargetFixture({ fixtureRoot, registry, bundle, appId: 'boss', marker: 'boss-v3' });
    await assert.rejects(
      publishWindowsAppProjection({
        bundleRoot: fixtureRoot,
        appIds: ['boss'],
        preserveExistingApps: true,
      }),
      /does not exactly match|inventory/i,
    );
    assert.equal(
      await fs.readFile(path.join(fixtureRoot, 'dist/apps/boss/app/boss', registry.apps.boss.icon), 'utf8'),
      'boss-v2',
      'an invalid preserved projection must block replacement before the targeted app is published',
    );
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
