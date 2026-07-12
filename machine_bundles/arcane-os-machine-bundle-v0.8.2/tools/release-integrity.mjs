import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_SCHEMA_VERSION = 2;
export const RELEASE_HASH_ALGORITHM = 'sha256';

export const PLATFORM_REQUIRED_FILES = Object.freeze({
  windows: Object.freeze([
    'ArcaneShell.exe',
    'ArcaneProvisioner.exe',
    'ArcaneCore.exe',
    'ArcanePipeGuard.exe',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
  ]),
  linux: Object.freeze([
    'ArcaneShell',
    'ArcaneProvisioner',
    'ArcaneCore',
  ]),
});

export const REQUIRED_APPLICATION_FILES = Object.freeze([
  'app/shared/arcane-api.js',
  'app/shared/arcane-sigil.svg',
  'app/shared/arcane-sigil-512.png',
  'app/shared/arcane-sigil.ico',
  'app/provisioner/index.html',
  'app/provisioner/manifest.webmanifest',
  'app/shell/index.html',
  'app/shell/manifest.webmanifest',
]);

function releasePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

export function assertSafeReleasePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || relativePath.includes(':') || relativePath.includes('\0')) {
    throw new Error(`Invalid release path: ${JSON.stringify(relativePath)}.`);
  }
  if (path.posix.isAbsolute(relativePath)) throw new Error(`Release path must be relative: ${relativePath}.`);
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Release path is not normalized: ${relativePath}.`);
  }
  return relativePath;
}

async function collectDirectoryFiles(directory, relativeDirectory, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = releasePath(path.join(relativeDirectory, entry.name));
    if (entry.isSymbolicLink()) throw new Error(`Release payload cannot contain a symbolic link: ${relativePath}.`);
    if (entry.isDirectory()) await collectDirectoryFiles(absolutePath, relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`Release payload contains an unsupported filesystem entry: ${relativePath}.`);
  }
}

export async function collectReleasePaths(dist) {
  const files = [];
  const entries = await fs.readdir(dist, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (entry.name === 'arcane-release.json' || entry.name === '.gitkeep') continue;
    const absolutePath = path.join(dist, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release payload cannot contain a symbolic link: ${entry.name}.`);
    if (entry.isDirectory()) {
      if (entry.name !== 'app') throw new Error(`Unexpected release directory: ${entry.name}.`);
      await collectDirectoryFiles(absolutePath, entry.name, files);
    } else if (entry.isFile()) files.push(entry.name);
    else throw new Error(`Release payload contains an unsupported filesystem entry: ${entry.name}.`);
  }
  return files.sort();
}

async function hashFile(file) {
  const data = await fs.readFile(file);
  return crypto.createHash(RELEASE_HASH_ALGORITHM).update(data).digest('hex');
}

export async function createReleaseManifest({ dist, bundle, platform, createdAt = new Date().toISOString() }) {
  const required = PLATFORM_REQUIRED_FILES[platform];
  if (!required) throw new Error('Pass windows or linux.');
  const paths = await collectReleasePaths(dist);
  for (const requiredPath of [...required, 'arcane-bundle.json', ...REQUIRED_APPLICATION_FILES]) {
    if (!paths.includes(requiredPath)) throw new Error(`Required release file is missing: ${requiredPath}.`);
  }
  const appFiles = paths.filter((relativePath) => relativePath.startsWith('app/'));
  if (!appFiles.length) throw new Error('The release contains no application payload files.');

  const files = [];
  for (const relativePath of paths) {
    assertSafeReleasePath(relativePath);
    const file = path.join(dist, ...relativePath.split('/'));
    const stat = await fs.stat(file);
    files.push({
      path: relativePath,
      size: stat.size,
      sha256: await hashFile(file),
    });
  }
  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    name: bundle.name,
    version: bundle.version,
    platform,
    architecture: 'x64',
    hashAlgorithm: RELEASE_HASH_ALGORITHM,
    createdAt,
    files,
  };
}

export async function verifyReleaseManifest({ dist, manifest, platform, version }) {
  const required = PLATFORM_REQUIRED_FILES[platform];
  if (!required) throw new Error('Pass windows or linux.');
  if (!manifest || manifest.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    throw new Error(`Release manifest schema ${RELEASE_SCHEMA_VERSION} is required.`);
  }
  if (manifest.hashAlgorithm !== RELEASE_HASH_ALGORITHM) throw new Error('Release manifest must use SHA-256.');
  if (manifest.platform !== platform) throw new Error(`Release manifest targets ${manifest.platform || 'an unknown platform'}, not ${platform}.`);
  if (manifest.version !== version) throw new Error(`Release manifest version ${manifest.version || 'unknown'} does not match ${version}.`);
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Release manifest has no files.');

  const actualPaths = await collectReleasePaths(dist);
  const entries = new Map();
  for (const entry of manifest.files) {
    const relativePath = assertSafeReleasePath(entry && entry.path);
    if (entries.has(relativePath)) throw new Error(`Release manifest contains a duplicate path: ${relativePath}.`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Release manifest has an invalid size for ${relativePath}.`);
    if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) throw new Error(`Release manifest has an invalid SHA-256 for ${relativePath}.`);
    entries.set(relativePath, entry);
  }
  if (entries.size !== actualPaths.length || actualPaths.some((relativePath) => !entries.has(relativePath))) {
    throw new Error('Release manifest file inventory does not exactly match the dist payload.');
  }
  for (const requiredPath of [...required, 'arcane-bundle.json', ...REQUIRED_APPLICATION_FILES]) {
    if (!entries.has(requiredPath)) throw new Error(`Release manifest does not verify ${requiredPath}.`);
  }

  for (const relativePath of actualPaths) {
    const entry = entries.get(relativePath);
    const file = path.join(dist, ...relativePath.split('/'));
    const stat = await fs.stat(file);
    if (stat.size !== entry.size) throw new Error(`${relativePath} does not match the release manifest size.`);
    if ((await hashFile(file)).toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new Error(`${relativePath} does not match the release manifest SHA-256.`);
    }
  }
  return manifest.files.map((entry) => ({ ...entry }));
}
