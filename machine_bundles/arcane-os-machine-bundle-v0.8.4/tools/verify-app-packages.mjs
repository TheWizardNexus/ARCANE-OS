import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackagedAppLinks } from './app-package-links.mjs';
import { verifyAppContentManifest } from './app-catalog.mjs';
import { loadAppRegistry, normalizeNavigationEntry, resolveBundledAppIds } from './app-packager-lib.mjs';
import { verifyWindowsDpiExecutable } from './verify-windows-dpi.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetsRoot = path.join(bundleRoot, 'dist', 'targets');
const registry = await loadAppRegistry(bundleRoot);

for (const appId of Object.keys(registry.apps).sort()) {
  const target = path.join(targetsRoot, appId);
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'arcane-app-package.json'), 'utf8'));
  assert.equal(manifest.app.id, appId);
  assert.equal(manifest.app.displayName, registry.apps[appId].displayName);
  assert.equal(manifest.app.description, registry.apps[appId].description);
  assert.equal(manifest.app.icon, registry.apps[appId].icon);
  assert.equal(manifest.app.order, registry.apps[appId].order);
  assert.deepEqual(manifest.app.capabilities, registry.apps[appId].capabilities);
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  assert.equal(expected.size, manifest.files.length, `${appId} has duplicate inventory paths`);
  const actual = [];
  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), `${appId} contains symbolic link ${relative}`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && relative !== 'arcane-app-package.json') actual.push(relative);
    }
  }
  await visit(target);
  actual.sort();
  assert.deepEqual(actual, [...expected.keys()].sort(), `${appId} inventory is not exact`);
  for (const relative of actual) {
    const data = await fs.readFile(path.join(target, ...relative.split('/')));
    const entry = expected.get(relative);
    assert.equal(data.length, entry.size, `${appId}/${relative} size mismatch`);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), entry.sha256, `${appId}/${relative} hash mismatch`);
  }
  assert(Array.isArray(manifest.app.security?.navigationEntries) && manifest.app.security.navigationEntries.length > 0, `${appId} has no secured navigation allowlist`);
  const navigationEntries = manifest.app.security.navigationEntries.map((navigationEntry) => (
    normalizeNavigationEntry(navigationEntry, appId, `${appId} navigation entry`)
  ));
  assert.deepEqual(
    navigationEntries,
    [...new Set(navigationEntries)].sort(),
    `${appId} navigation allowlist must be unique and sorted`,
  );
  assert.equal(
    new Set(navigationEntries.map((navigationEntry) => navigationEntry.toLowerCase())).size,
    navigationEntries.length,
    `${appId} navigation allowlist collides on Windows`,
  );
  for (const navigationEntry of navigationEntries) {
    const html = await fs.readFile(path.join(target, 'app', ...navigationEntry.slice(1).split('/')), 'utf8');
    assert(html.includes(`http-equiv="Content-Security-Policy" content="${manifest.app.security.contentSecurityPolicy}"`), `${navigationEntry} is missing its declared CSP`);
    assert(html.includes(`http-equiv="Permissions-Policy" content="${manifest.app.security.permissionsPolicy}"`), `${navigationEntry} is missing its declared Permissions-Policy`);
  }
  if (manifest.platform === 'windows') {
    assert(manifest.native?.launcher, `${appId} is missing its native launcher declaration`);
    assert(expected.has('arcane-app-content.json'), `${appId} is missing its exact content manifest`);
    for (const required of [manifest.native.launcher, manifest.native.core, manifest.native.pipeGuard, 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']) {
      assert(expected.has(required), `${appId} native package is missing ${required}`);
    }
    assert(!expected.has(`start-${appId}.bat`), `${appId} native package retains a mutable batch launcher`);
    await verifyAppContentManifest({
      target,
      appId,
      launcher: manifest.native.launcher,
      version: manifest.bundleVersion,
    });
    await verifyWindowsDpiExecutable(path.join(target, manifest.native.launcher));
  }
  const dependencies = await verifyPackagedAppLinks({
    packageRoot: target,
    appId,
    bundledAppIds: resolveBundledAppIds(registry, appId),
  });
  assert.equal(manifest.app.security?.verifiedDependencies, dependencies.length, `${appId} dependency count mismatch`);
  console.log(`Verified isolated Arcane app package ${appId} (${manifest.files.length} files, ${dependencies.length} local dependencies).`);
}
