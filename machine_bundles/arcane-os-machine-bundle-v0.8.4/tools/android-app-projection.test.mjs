import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAppRegistry } from './app-packager-lib.mjs';
import {
  ANDROID_APP_CATALOG,
  ANDROID_APP_CONTENT_MANIFEST,
  ANDROID_APP_PACKAGE_MANIFEST,
  publishAndroidAppProjection,
} from './build-android-app-projection.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function inventory(root) {
  const files = [];
  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && relative !== ANDROID_APP_PACKAGE_MANIFEST) {
        const data = await fs.readFile(absolute);
        files.push({ path: relative, size: data.length, sha256: hash(data) });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => compareText(left.path, right.path));
}

async function createFixture() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-android-projection-'));
  await fs.mkdir(path.join(fixtureRoot, 'dist', 'targets'), { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(bundleRoot, 'arcane-apps.json'), path.join(fixtureRoot, 'arcane-apps.json')),
    fs.copyFile(path.join(bundleRoot, 'arcane-bundle.json'), path.join(fixtureRoot, 'arcane-bundle.json')),
    fs.mkdir(path.join(fixtureRoot, 'src', 'frontend', 'shared'), { recursive: true })
      .then(() => fs.copyFile(
        path.join(bundleRoot, 'src', 'frontend', 'shared', 'arcane-api.js'),
        path.join(fixtureRoot, 'src', 'frontend', 'shared', 'arcane-api.js'),
      )),
  ]);
  const [registry, bundle] = await Promise.all([
    loadAppRegistry(fixtureRoot),
    fs.readFile(path.join(fixtureRoot, 'arcane-bundle.json'), 'utf8').then(JSON.parse),
  ]);
  return { fixtureRoot, registry, bundle };
}

async function writePortableTarget({ fixtureRoot, registry, bundle, appId = 'calculator', apiData: requestedApiData }) {
  const configured = registry.apps[appId];
  const target = path.join(fixtureRoot, 'dist', 'targets', appId);
  await fs.mkdir(path.join(target, 'app', appId, path.dirname(configured.icon)), { recursive: true });
  await fs.mkdir(path.join(target, 'app', 'arcane-runtime'), { recursive: true });
  await fs.mkdir(path.join(target, 'runtime'), { recursive: true });
  const apiData = requestedApiData
    ?? await fs.readFile(path.join(fixtureRoot, 'src', 'frontend', 'shared', 'arcane-api.js'));
  await fs.writeFile(path.join(target, 'app', 'arcane-runtime', 'arcane-api.js'), apiData);
  await fs.writeFile(path.join(target, 'app', appId, 'index.html'), '<!doctype html><title>Fixture</title>\n');
  await fs.writeFile(path.join(target, 'app', appId, configured.icon), Buffer.from([1, 3, 3, 7]));
  await fs.writeFile(path.join(target, 'runtime', 'arcane-core.cjs'), 'module.exports = {};\n');
  const packagedBundle = {
    ...bundle,
    apps: {
      [appId]: {
        displayName: configured.displayName,
        description: configured.description,
        icon: configured.icon,
        order: configured.order,
        type: 'app',
        entry: `${appId}/index.html`,
        capabilities: configured.capabilities,
      },
    },
  };
  await fs.writeFile(path.join(target, 'arcane-bundle.json'), json(packagedBundle));
  const files = await inventory(target);
  const packageManifest = {
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
        permissionsPolicy: 'camera=()',
        securedDocuments: 1,
        navigationEntries: [`/${appId}/index.html`],
        verifiedDependencies: 0,
      },
      documentCatalog: null,
    },
    files,
  };
  const packageManifestData = Buffer.from(json(packageManifest));
  await fs.writeFile(path.join(target, ANDROID_APP_PACKAGE_MANIFEST), packageManifestData);
  return { target, apiData, packageManifest, packageManifestData };
}

test('Android projection preserves portable provenance and propagates the source API hash', async () => {
  const fixture = await createFixture();
  try {
    const source = await writePortableTarget(fixture);
    const published = await publishAndroidAppProjection({
      bundleRoot: fixture.fixtureRoot,
      appIds: ['calculator'],
    });
    assert.equal(published.target, path.join(fixture.fixtureRoot, 'dist', 'android-apps'));
    const projectionNames = (await fs.readdir(published.target)).sort(compareText);
    assert.deepEqual(projectionNames, ['calculator', ANDROID_APP_CATALOG].sort(compareText));
    const appProjection = path.join(published.target, 'calculator');
    assert.deepEqual(
      (await fs.readdir(appProjection)).sort(compareText),
      ['app', ANDROID_APP_CONTENT_MANIFEST, ANDROID_APP_PACKAGE_MANIFEST].sort(compareText),
    );
    await assert.rejects(fs.access(path.join(appProjection, 'runtime')), /ENOENT/);
    await assert.rejects(fs.access(path.join(appProjection, 'arcane-bundle.json')), /ENOENT/);

    const projectedPackageData = await fs.readFile(path.join(appProjection, ANDROID_APP_PACKAGE_MANIFEST));
    assert.deepEqual(projectedPackageData, source.packageManifestData);
    const contentData = await fs.readFile(path.join(appProjection, ANDROID_APP_CONTENT_MANIFEST));
    const content = JSON.parse(contentData);
    assert.deepEqual(Object.keys(content), ['schemaVersion', 'hashAlgorithm', 'app', 'files']);
    assert.deepEqual(content.app, { id: 'calculator', version: fixture.bundle.version });
    assert(content.files.every((entry) => entry.path.startsWith('app/')));
    const sourceApiEntry = source.packageManifest.files.find((entry) => entry.path === 'app/arcane-runtime/arcane-api.js');
    const projectedApiEntry = content.files.find((entry) => entry.path === 'app/arcane-runtime/arcane-api.js');
    assert.deepEqual(projectedApiEntry, sourceApiEntry);
    assert.deepEqual(
      await fs.readFile(path.join(appProjection, 'app', 'arcane-runtime', 'arcane-api.js')),
      source.apiData,
    );

    const catalogData = await fs.readFile(path.join(published.target, ANDROID_APP_CATALOG));
    const catalog = JSON.parse(catalogData);
    assert.deepEqual(Object.keys(catalog), ['schemaVersion', 'protocolVersion', 'bundleVersion', 'apps']);
    assert.equal(catalog.apps.length, 1);
    assert.deepEqual(Object.keys(catalog.apps[0]), [
      'id',
      'displayName',
      'description',
      'icon',
      'order',
      'version',
      'capabilities',
      'contentManifestSha256',
      'packageManifestSha256',
    ]);
    assert.equal(catalog.apps[0].contentManifestSha256, hash(contentData));
    assert.equal(catalog.apps[0].packageManifestSha256, hash(source.packageManifestData));
    assert.equal(catalog.apps[0].icon, `calculator/app/calculator/${fixture.registry.apps.calculator.icon}`);
  } finally {
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('Android projection rejects tampered portable bytes without replacing the last projection', async () => {
  const fixture = await createFixture();
  try {
    const source = await writePortableTarget(fixture);
    const existing = path.join(fixture.fixtureRoot, 'dist', 'android-apps');
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, 'sentinel.txt'), 'previous verified projection\n');
    await fs.writeFile(
      path.join(source.target, 'app', 'arcane-runtime', 'arcane-api.js'),
      'export const apiFixture = "tampered";\n',
    );
    await assert.rejects(
      () => publishAndroidAppProjection({ bundleRoot: fixture.fixtureRoot, appIds: ['calculator'] }),
      /outer package manifest does not exactly match the portable target bytes/,
    );
    assert.equal(
      await fs.readFile(path.join(existing, 'sentinel.txt'), 'utf8'),
      'previous verified projection\n',
    );
    assert.deepEqual(await fs.readdir(existing), ['sentinel.txt']);
    assert.deepEqual(
      (await fs.readdir(path.join(fixture.fixtureRoot, 'dist'))).filter((name) => name.startsWith('.android-apps-stage-')),
      [],
    );
  } finally {
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('Android projection rejects stale identity and malformed portable layout', async () => {
  const staleFixture = await createFixture();
  try {
    const source = await writePortableTarget(staleFixture);
    const staleManifest = JSON.parse(await fs.readFile(path.join(source.target, ANDROID_APP_PACKAGE_MANIFEST), 'utf8'));
    staleManifest.bundleVersion = '0.0.0-stale';
    await fs.writeFile(path.join(source.target, ANDROID_APP_PACKAGE_MANIFEST), json(staleManifest));
    await assert.rejects(
      () => publishAndroidAppProjection({ bundleRoot: staleFixture.fixtureRoot, appIds: ['calculator'] }),
      /package identity is stale/,
    );
  } finally {
    await fs.rm(staleFixture.fixtureRoot, { recursive: true, force: true });
  }

  const malformedFixture = await createFixture();
  try {
    const source = await writePortableTarget(malformedFixture);
    await fs.writeFile(path.join(source.target, 'unexpected.txt'), 'not in a portable target\n');
    await assert.rejects(
      () => publishAndroidAppProjection({ bundleRoot: malformedFixture.fixtureRoot, appIds: ['calculator'] }),
      /missing or unexpected top-level entries/,
    );
  } finally {
    await fs.rm(malformedFixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('Android projection rejects a self-consistent package built with a stale frontend API', async () => {
  const fixture = await createFixture();
  try {
    await writePortableTarget({
      ...fixture,
      apiData: Buffer.from('export const staleApi = true;\n'),
    });
    await assert.rejects(
      () => publishAndroidAppProjection({ bundleRoot: fixture.fixtureRoot, appIds: ['calculator'] }),
      /contains a stale Arcane frontend API/,
    );
  } finally {
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
