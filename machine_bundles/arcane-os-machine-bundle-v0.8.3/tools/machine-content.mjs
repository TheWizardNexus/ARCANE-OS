import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MACHINE_CONTENT_MANIFEST = 'arcane-machine-content.json';
export const MACHINE_CONTENT_SCHEMA_VERSION = 1;
export const MACHINE_ROOT_DIRECTORIES = Object.freeze(['app', 'apps', 'bin']);
export const MACHINE_ROOT_REQUIRED_FILES = Object.freeze(['arcane-bundle.json']);
export const MACHINE_BIN_CONTENT_FILES = Object.freeze([
  'ArcaneCore.exe',
  'ArcaneOllamaService.exe',
  'ArcanePipeGuard.exe',
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll',
  'WebView2Loader.dll',
]);
export const MACHINE_BIN_HOST_FILES = Object.freeze(['ArcaneProvisioner.exe', 'ArcaneShell.exe']);
export const MACHINE_CONTENT_EXCLUSIONS = Object.freeze([
  'arcane-install.json',
  MACHINE_CONTENT_MANIFEST,
  'arcane-release.json',
  'bin/ArcaneProvisioner.exe',
  'bin/ArcaneShell.exe',
]);

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function fail(message) {
  throw new Error(`Invalid Arcane machine content: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${label} contains unknown field "${key}".`);
}

export function normalizeMachinePath(value, label = 'path') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || /[\x00-\x1f]/.test(value)) {
    fail(`${label} must use canonical forward-slash relative syntax.`);
  }
  if (path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.startsWith('//')) fail(`${label} must be relative.`);
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) fail(`${label} traverses its root.`);
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ') || segment.includes(':')) {
      fail(`${label} contains an unsafe path segment.`);
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) fail(`${label} contains a Windows reserved path segment.`);
  }
  return value;
}

async function assertRegularRoot(root) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('release root must be a regular directory.');
}

function exactNames(actual, expected) {
  const left = [...actual].sort(compareText);
  const right = [...expected].sort(compareText);
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

async function assertExactMachineLayout(root, phase) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const expectedRoot = [...MACHINE_ROOT_DIRECTORIES, ...MACHINE_ROOT_REQUIRED_FILES];
  const names = entries.map((entry) => entry.name);
  if (names.includes(MACHINE_CONTENT_MANIFEST)) expectedRoot.push(MACHINE_CONTENT_MANIFEST);
  if (names.includes('arcane-release.json')) expectedRoot.push('arcane-release.json');
  if (phase === 'verify' && !names.includes(MACHINE_CONTENT_MANIFEST)) fail(`${MACHINE_CONTENT_MANIFEST} is missing.`);
  if (!exactNames(names, expectedRoot)) {
    fail('release root must contain exactly app, apps, bin, arcane-bundle.json, and only the phase-appropriate content/release manifests.');
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) fail(`release root contains reparse link "${entry.name}".`);
    const directory = MACHINE_ROOT_DIRECTORIES.includes(entry.name);
    if (directory ? !(entry.isDirectory() && stat.isDirectory()) : !(entry.isFile() && stat.isFile())) {
      fail(`release root contains invalid entry "${entry.name}".`);
    }
  }

  const bin = path.join(root, 'bin');
  const binEntries = await fs.readdir(bin, { withFileTypes: true });
  const binNames = binEntries.map((entry) => entry.name);
  const preHost = MACHINE_BIN_CONTENT_FILES;
  const complete = [...MACHINE_BIN_CONTENT_FILES, ...MACHINE_BIN_HOST_FILES];
  const validNames = phase === 'write'
    ? exactNames(binNames, preHost) || exactNames(binNames, complete)
    : exactNames(binNames, complete);
  if (!validNames) {
    fail(phase === 'write'
      ? 'pre-host bin must contain exactly Core, PipeGuard, and the three pinned WebView2 DLLs, with either both native hosts present or neither.'
      : 'verified bin must contain exactly Provisioner, Shell, Core, PipeGuard, and the three pinned WebView2 DLLs.');
  }
  for (const entry of binEntries) {
    const stat = await fs.lstat(path.join(bin, entry.name));
    if (!entry.isFile() || !stat.isFile() || stat.isSymbolicLink()) fail(`bin contains non-regular file "${entry.name}".`);
  }
  const catalog = path.join(root, 'apps', 'catalog.json');
  const catalogStat = await fs.lstat(catalog).catch(() => null);
  if (!catalogStat || !catalogStat.isFile() || catalogStat.isSymbolicLink()) fail('apps/catalog.json must be a regular file.');
}

export async function enumerateMachineContent(root, { phase = 'verify' } = {}) {
  const absoluteRoot = path.resolve(root);
  await assertRegularRoot(absoluteRoot);
  if (!['write', 'verify'].includes(phase)) fail('enumeration phase must be write or verify.');
  await assertExactMachineLayout(absoluteRoot, phase);
  const exclusions = new Set(MACHINE_CONTENT_EXCLUSIONS);
  const files = [];
  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length === 0) fail(`release contains empty directory "${relativeDirectory || '.'}".`);
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      normalizeMachinePath(relative);
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) fail(`release contains reparse link "${relative}".`);
      if (entry.isDirectory() && stat.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && stat.isFile()) {
        if (exclusions.has(relative)) continue;
        const data = await fs.readFile(absolute);
        files.push({ path: relative, size: data.length, sha256: sha256(data) });
      } else fail(`release contains unsupported filesystem entry "${relative}".`);
    }
  }
  await visit(absoluteRoot);
  files.sort((left, right) => compareText(left.path, right.path));
  return files;
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0) fail('manifest files must be a non-empty array.');
  const normalized = files.map((entry, index) => {
    const label = `files[${index}]`;
    assertOnlyKeys(entry, new Set(['path', 'size', 'sha256']), label);
    const relative = normalizeMachinePath(entry.path, `${label}.path`);
    if (MACHINE_CONTENT_EXCLUSIONS.includes(relative)) fail(`${label} includes an excluded release path.`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail(`${label}.size is invalid.`);
    if (typeof entry.sha256 !== 'string' || !HASH_PATTERN.test(entry.sha256)) fail(`${label}.sha256 is invalid.`);
    return { path: relative, size: entry.size, sha256: entry.sha256 };
  });
  const paths = normalized.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) fail('manifest contains duplicate paths.');
  const sorted = [...paths].sort(compareText);
  if (paths.some((entry, index) => entry !== sorted[index])) fail('manifest file inventory is not sorted canonically.');
  return normalized;
}

function parseManifest(data, expectedVersion) {
  let manifest;
  try { manifest = JSON.parse(data.toString('utf8')); } catch { fail('manifest is not valid JSON.'); }
  assertOnlyKeys(manifest, new Set(['schemaVersion', 'hashAlgorithm', 'release', 'files']), MACHINE_CONTENT_MANIFEST);
  if (manifest.schemaVersion !== MACHINE_CONTENT_SCHEMA_VERSION) fail(`manifest schema must be ${MACHINE_CONTENT_SCHEMA_VERSION}.`);
  if (manifest.hashAlgorithm !== 'sha256') fail('manifest hash algorithm must be sha256.');
  assertOnlyKeys(manifest.release, new Set(['name', 'version', 'platform', 'architecture']), 'release');
  if (typeof manifest.release.name !== 'string' || !manifest.release.name) fail('release name is invalid.');
  if (manifest.release.version !== expectedVersion) fail(`release version does not match ${expectedVersion}.`);
  if (manifest.release.platform !== 'windows' || manifest.release.architecture !== 'x64') fail('release platform must be Windows x64.');
  return { ...manifest, files: validateFiles(manifest.files) };
}

function inventoriesEqual(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index].path && entry.size === right[index].size && entry.sha256 === right[index].sha256
  ));
}

export async function writeMachineContentManifest({ releaseRoot, bundle }) {
  if (!isPlainObject(bundle) || typeof bundle.name !== 'string' || typeof bundle.version !== 'string') fail('bundle identity is incomplete.');
  const root = path.resolve(releaseRoot);
  const files = await enumerateMachineContent(root, { phase: 'write' });
  const manifest = {
    schemaVersion: MACHINE_CONTENT_SCHEMA_VERSION,
    hashAlgorithm: 'sha256',
    release: { name: bundle.name, version: bundle.version, platform: 'windows', architecture: 'x64' },
    files,
  };
  const data = Buffer.from(canonicalJson(manifest), 'utf8');
  const target = path.join(root, MACHINE_CONTENT_MANIFEST);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.rm(temporary, { force: true });
  await fs.writeFile(temporary, data, { flag: 'wx' });
  await fs.rename(temporary, target);
  return Object.freeze({ manifest, data, sha256: sha256(data) });
}

export async function verifyMachineContentManifest({ releaseRoot, version }) {
  const root = path.resolve(releaseRoot);
  const data = await fs.readFile(path.join(root, MACHINE_CONTENT_MANIFEST));
  const manifest = parseManifest(data, version);
  const actual = await enumerateMachineContent(root, { phase: 'verify' });
  if (!inventoriesEqual(manifest.files, actual)) fail('manifest does not exactly match the release payload.');
  return Object.freeze({ manifest, data, sha256: sha256(data) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const releaseRoot = path.resolve(process.argv[3] || '');
  if (!['write', 'verify'].includes(command) || !process.argv[3]) throw new Error('Usage: node tools/machine-content.mjs write|verify <release-root> [version]');
  const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = JSON.parse(await fs.readFile(path.join(bundleRoot, 'arcane-bundle.json'), 'utf8'));
  const result = command === 'write'
    ? await writeMachineContentManifest({ releaseRoot, bundle })
    : await verifyMachineContentManifest({ releaseRoot, version: process.argv[4] || bundle.version });
  console.log(JSON.stringify({ manifest: MACHINE_CONTENT_MANIFEST, sha256: result.sha256, files: result.manifest.files.length }));
}
