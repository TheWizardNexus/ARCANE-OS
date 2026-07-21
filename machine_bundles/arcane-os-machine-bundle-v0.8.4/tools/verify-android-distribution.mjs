import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distribution = path.join(root, 'dist', 'android');
const manifestPath = path.join(distribution, 'arcane-android-distribution.json');
const manifestSource = await fs.readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestSource);
assert.equal(manifestSource, `${JSON.stringify(manifest, null, 2)}\n`);
assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'bundleVersion', 'buildMode', 'signingClaim', 'packages']);
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.bundleVersion, '0.8.4');
assert.equal(manifest.buildMode, 'debug-local-test');
assert.equal(manifest.signingClaim, 'android-debug-key-no-publisher-trust');
assert(Array.isArray(manifest.packages));
assert.equal(manifest.packages.length, 18);
assert.equal(manifest.packages.filter((entry) => entry.type === 'launcher').length, 1);
assert.equal(manifest.packages.filter((entry) => entry.type === 'application').length, 17);

const expectedFiles = new Set(['arcane-android-distribution.json']);
const identifiers = new Set();
const packageNames = new Set();
for (const entry of manifest.packages) {
  assert.equal(typeof entry.id, 'string');
  assert(!identifiers.has(entry.id));
  identifiers.add(entry.id);
  assert.equal(typeof entry.packageName, 'string');
  assert(!packageNames.has(entry.packageName));
  packageNames.add(entry.packageName);
  assert.match(entry.file, /^Arcane(?:Launcher|App-[a-z0-9-]+)-debug\.apk$/);
  expectedFiles.add(entry.file);
  const data = await fs.readFile(path.join(distribution, entry.file));
  assert.equal(entry.size, data.length);
  assert.equal(entry.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  assert.equal(entry.version, manifest.bundleVersion);
}
const actualFiles = new Set(await fs.readdir(distribution));
assert.deepEqual([...actualFiles].sort(), [...expectedFiles].sort());
console.log(`Verified ${manifest.packages.length} exact debug-local-test Android APKs.`);
