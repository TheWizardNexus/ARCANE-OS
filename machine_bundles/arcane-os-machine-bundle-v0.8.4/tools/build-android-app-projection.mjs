import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadAppRegistry,
  normalizeNavigationEntry,
  normalizeRelativePath,
} from './app-packager-lib.mjs';

export const ANDROID_APP_CATALOG = 'catalog.json';
export const ANDROID_APP_CONTENT_MANIFEST = 'arcane-app-content.json';
export const ANDROID_APP_PACKAGE_MANIFEST = 'arcane-app-package.json';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PORTABLE_TARGET_ENTRIES = Object.freeze([
  'app',
  ANDROID_APP_PACKAGE_MANIFEST,
  'arcane-bundle.json',
  'runtime',
]);
const PORTABLE_PACKAGE_KEYS = new Set([
  'schemaVersion',
  'protocolVersion',
  'bundleVersion',
  'app',
  'files',
]);
const PORTABLE_APP_KEYS = new Set([
  'id',
  'displayName',
  'description',
  'icon',
  'order',
  'type',
  'entry',
  'launchEntry',
  'capabilities',
  'security',
  'documentCatalog',
]);
const SECURITY_KEYS = new Set([
  'contentSecurityPolicy',
  'permissionsPolicy',
  'securedDocuments',
  'navigationEntries',
  'verifiedDependencies',
]);
const FILE_ENTRY_KEYS = new Set(['path', 'size', 'sha256']);
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_FILES = 8_192;

function fail(message) {
  throw new Error(`Invalid Arcane Android app projection: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort(compareText);
  const required = [...expected].sort(compareText);
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail(`${label} must contain exactly: ${required.join(', ')}.`);
  }
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function lstatOrNull(candidate) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function requireRegularDirectory(candidate, label) {
  const stat = await lstatOrNull(candidate);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a regular directory.`);
  return stat;
}

async function readRegularFile(candidate, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const stat = await lstatOrNull(candidate);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file.`);
  if (stat.size > maximumBytes) fail(`${label} is too large.`);
  const data = await fs.readFile(candidate);
  const after = await fs.lstat(candidate);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== data.length) {
    fail(`${label} changed while it was being read.`);
  }
  return data;
}

function parseJson(data, label) {
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON.`);
  }
}

function validateFileInventory(files, label) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_PACKAGE_FILES) {
    fail(`${label} must contain a bounded non-empty file inventory.`);
  }
  const seen = new Set();
  const seenCaseInsensitive = new Set();
  let previous = null;
  return files.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    exactKeys(entry, FILE_ENTRY_KEYS, entryLabel);
    const relative = normalizeRelativePath(entry.path, `${entryLabel}.path`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail(`${entryLabel}.size must be a non-negative safe integer.`);
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) fail(`${entryLabel}.sha256 is invalid.`);
    if (seen.has(relative)) fail(`${label} repeats "${relative}".`);
    const folded = relative.toLowerCase();
    if (seenCaseInsensitive.has(folded)) fail(`${label} contains a case-insensitive path collision at "${relative}".`);
    if (previous !== null && compareText(previous, relative) >= 0) fail(`${label} must be uniquely and canonically ordered.`);
    seen.add(relative);
    seenCaseInsensitive.add(folded);
    previous = relative;
    return Object.freeze({ path: relative, size: entry.size, sha256: entry.sha256 });
  });
}

function validatePortableIdentity({ manifest, appId, configured, bundle }) {
  exactKeys(manifest, PORTABLE_PACKAGE_KEYS, ANDROID_APP_PACKAGE_MANIFEST);
  if (manifest.schemaVersion !== 1) fail(`${appId} package schema version must be 1.`);
  if (manifest.protocolVersion !== bundle.protocolVersion || manifest.bundleVersion !== bundle.version) {
    fail(`${appId} package identity is stale or does not match the current machine bundle.`);
  }
  exactKeys(manifest.app, PORTABLE_APP_KEYS, `${appId} package app descriptor`);
  const packaged = manifest.app;
  if (
    packaged.id !== appId
    || packaged.displayName !== configured.displayName
    || packaged.description !== configured.description
    || packaged.icon !== configured.icon
    || packaged.order !== configured.order
    || packaged.type !== 'app'
  ) fail(`${appId} package presentation identity does not match the app registry.`);
  if (!arraysEqual(packaged.capabilities, configured.capabilities)) {
    fail(`${appId} package capabilities do not exactly match the app registry.`);
  }
  const expectedEntry = `${appId}/index.html`;
  if (packaged.entry !== expectedEntry || packaged.launchEntry !== expectedEntry) {
    fail(`${appId} package launch entry is not canonical.`);
  }

  exactKeys(packaged.security, SECURITY_KEYS, `${appId} package security descriptor`);
  const security = packaged.security;
  if (typeof security.contentSecurityPolicy !== 'string' || security.contentSecurityPolicy.length === 0) {
    fail(`${appId} package content security policy is missing.`);
  }
  if (typeof security.permissionsPolicy !== 'string' || security.permissionsPolicy.length === 0) {
    fail(`${appId} package permissions policy is missing.`);
  }
  for (const field of ['securedDocuments', 'verifiedDependencies']) {
    if (!Number.isSafeInteger(security[field]) || security[field] < 0) {
      fail(`${appId} package ${field} value is invalid.`);
    }
  }
  if (!Array.isArray(security.navigationEntries) || security.navigationEntries.length === 0) {
    fail(`${appId} package navigation allowlist is missing.`);
  }
  const navigationEntries = security.navigationEntries.map((entry, index) => (
    normalizeNavigationEntry(entry, appId, `${appId} package navigationEntries[${index}]`)
  ));
  const canonicalNavigationEntries = [...new Set(navigationEntries)].sort(compareText);
  if (!arraysEqual(navigationEntries, canonicalNavigationEntries)) {
    fail(`${appId} package navigation allowlist must be unique and canonically ordered.`);
  }
  if (!navigationEntries.includes(`/${expectedEntry}`)) {
    fail(`${appId} package navigation allowlist omits its launch entry.`);
  }

  if (configured.documentCatalog === null) {
    if (packaged.documentCatalog !== null) fail(`${appId} package declares an unexpected document catalog.`);
  } else {
    exactKeys(packaged.documentCatalog, new Set(['policy', 'count', 'destination']), `${appId} package document catalog`);
    if (
      packaged.documentCatalog.policy !== configured.documentCatalog.policy
      || packaged.documentCatalog.destination !== configured.documentCatalog.destination
      || packaged.documentCatalog.count !== 0
    ) fail(`${appId} package document catalog does not match the app registry.`);
  }

  return validateFileInventory(manifest.files, `${ANDROID_APP_PACKAGE_MANIFEST}.files`);
}

async function assertPortableTargetLayout(target, appId) {
  await requireRegularDirectory(target, `${appId} portable target`);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort(compareText);
  if (names.length !== PORTABLE_TARGET_ENTRIES.length || names.some((name, index) => name !== PORTABLE_TARGET_ENTRIES[index])) {
    fail(`${appId} portable target contains missing or unexpected top-level entries.`);
  }
  for (const entry of entries) {
    const stat = await fs.lstat(path.join(target, entry.name));
    if (stat.isSymbolicLink()) fail(`${appId} portable target contains symbolic link "${entry.name}".`);
    const shouldBeDirectory = entry.name === 'app' || entry.name === 'runtime';
    if (shouldBeDirectory ? !stat.isDirectory() : !stat.isFile()) {
      fail(`${appId} portable target entry "${entry.name}" has the wrong type.`);
    }
  }
}

async function enumeratePackageFiles(root, excluded = new Set()) {
  const files = [];
  const dataByPath = new Map();
  const caseInsensitivePaths = new Set();

  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length === 0) fail(`portable package contains empty directory "${relativeDirectory || '.'}".`);
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = normalizeRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
        'portable package path',
      );
      const absolute = path.resolve(root, ...relative.split('/'));
      if (!isInside(root, absolute)) fail(`portable package path "${relative}" escapes its target root.`);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || entry.isSymbolicLink()) fail(`portable package contains symbolic link "${relative}".`);
      if (stat.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!stat.isFile()) fail(`portable package entry "${relative}" is not a regular file.`);
      if (excluded.has(relative)) continue;
      if (files.length >= MAX_PACKAGE_FILES) fail('portable package contains too many files.');
      const folded = relative.toLowerCase();
      if (caseInsensitivePaths.has(folded)) fail(`portable package contains a case-insensitive path collision at "${relative}".`);
      const data = await fs.readFile(absolute);
      const after = await fs.lstat(absolute);
      if (!after.isFile() || after.isSymbolicLink() || after.size !== data.length) {
        fail(`portable package file "${relative}" changed while it was being read.`);
      }
      files.push(Object.freeze({ path: relative, size: data.length, sha256: sha256(data) }));
      dataByPath.set(relative, data);
      caseInsensitivePaths.add(folded);
    }
  }

  await visit(root);
  files.sort((left, right) => compareText(left.path, right.path));
  return Object.freeze({ files: Object.freeze(files), dataByPath });
}

function inventoriesEqual(expected, actual) {
  return expected.length === actual.length && expected.every((entry, index) => (
    entry.path === actual[index].path
    && entry.size === actual[index].size
    && entry.sha256 === actual[index].sha256
  ));
}

function expectedPackagedBundle(bundle, configured, appId) {
  return {
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
}

async function verifyPortableAppPackage({ targetsRoot, appId, configured, bundle, expectedApiData }) {
  const target = path.resolve(targetsRoot, appId);
  if (!isInside(targetsRoot, target) || target === targetsRoot) fail(`${appId} target path escapes dist/targets.`);
  await assertPortableTargetLayout(target, appId);
  const targetsReal = await fs.realpath(targetsRoot);
  const targetReal = await fs.realpath(target);
  if (!isInside(targetsReal, targetReal) || targetReal === targetsReal) fail(`${appId} target resolves outside dist/targets.`);

  const packageManifestPath = path.join(target, ANDROID_APP_PACKAGE_MANIFEST);
  const packageManifestData = await readRegularFile(
    packageManifestPath,
    `${appId}/${ANDROID_APP_PACKAGE_MANIFEST}`,
    MAX_MANIFEST_BYTES,
  );
  const packageManifest = parseJson(packageManifestData, `${appId}/${ANDROID_APP_PACKAGE_MANIFEST}`);
  const expectedFiles = validatePortableIdentity({ manifest: packageManifest, appId, configured, bundle });
  const actual = await enumeratePackageFiles(target, new Set([ANDROID_APP_PACKAGE_MANIFEST]));
  if (!inventoriesEqual(expectedFiles, actual.files)) {
    fail(`${appId} outer package manifest does not exactly match the portable target bytes.`);
  }

  const packagedBundleData = actual.dataByPath.get('arcane-bundle.json');
  const packagedBundle = parseJson(packagedBundleData, `${appId}/arcane-bundle.json`);
  if (!isDeepStrictEqual(packagedBundle, expectedPackagedBundle(bundle, configured, appId))) {
    fail(`${appId} packaged bundle is stale or does not match the current bundle and registry.`);
  }
  const requiredFiles = [
    'app/arcane-runtime/arcane-api.js',
    `app/${appId}/index.html`,
    `app/${appId}/${configured.icon}`,
    'runtime/arcane-core.cjs',
  ];
  for (const relative of requiredFiles) {
    if (!actual.dataByPath.has(relative)) fail(`${appId} portable target omits required file "${relative}".`);
  }
  const apiPath = 'app/arcane-runtime/arcane-api.js';
  const expectedApiSha256 = sha256(expectedApiData);
  const packagedApiEntry = expectedFiles.find((entry) => entry.path === apiPath);
  if (packagedApiEntry.sha256 !== expectedApiSha256 || !actual.dataByPath.get(apiPath).equals(expectedApiData)) {
    fail(`${appId} portable target contains a stale Arcane frontend API.`);
  }
  return Object.freeze({ packageManifest, packageManifestData, files: actual.files, dataByPath: actual.dataByPath });
}

async function writeInside(root, relative, data) {
  const normalized = normalizeRelativePath(relative, 'Android projection path');
  const target = path.resolve(root, ...normalized.split('/'));
  if (!isInside(root, target) || target === root) fail(`Android projection path "${relative}" escapes its staging root.`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data, { flag: 'wx' });
}

function createCatalog({ bundle, registry, packages }) {
  const apps = packages.map((item) => {
    const configured = registry.apps[item.appId];
    const packagedIcon = `app/${item.appId}/${configured.icon}`;
    if (!item.contentManifest.files.some((entry) => entry.path === packagedIcon)) {
      fail(`${item.appId} Android content manifest omits its configured icon.`);
    }
    return {
      id: item.appId,
      displayName: configured.displayName,
      description: configured.description,
      icon: `${item.appId}/${packagedIcon}`,
      order: configured.order,
      version: bundle.version,
      capabilities: [...configured.capabilities],
      contentManifestSha256: sha256(item.contentManifestData),
      packageManifestSha256: sha256(item.packageManifestData),
    };
  });
  apps.sort((left, right) => left.order - right.order || compareText(left.id, right.id));
  return Object.freeze({
    schemaVersion: 1,
    protocolVersion: bundle.protocolVersion,
    bundleVersion: bundle.version,
    apps: Object.freeze(apps),
  });
}

async function replaceDirectoryAtomically(staging, target, parent) {
  if (!isInside(parent, staging) || !isInside(parent, target) || target === parent) {
    fail('Android projection publication path escapes dist.');
  }
  const existing = await lstatOrNull(target);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    fail('existing dist/android-apps projection is not a regular directory.');
  }
  const token = path.basename(staging).slice('.android-apps-stage-'.length);
  const backup = path.join(parent, `.android-apps-backup-${token}`);
  if (!isInside(parent, backup)) fail('Android projection backup path escapes dist.');
  let movedExisting = false;
  try {
    try {
      await fs.rename(target, backup);
      movedExisting = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fs.rename(staging, target);
    if (movedExisting) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!(await lstatOrNull(target)) && movedExisting) await fs.rename(backup, target);
    throw error;
  }
}

function selectedAppIds(registry, requested) {
  const appIds = requested === undefined ? Object.keys(registry.apps) : requested;
  if (!Array.isArray(appIds) || appIds.length === 0) fail('appIds must be a non-empty array when provided.');
  const seen = new Set();
  const selected = appIds.map((appId) => {
    if (typeof appId !== 'string' || !Object.hasOwn(registry.apps, appId)) fail(`appIds contains unregistered app "${appId}".`);
    if (seen.has(appId)) fail(`appIds repeats app "${appId}".`);
    seen.add(appId);
    return appId;
  });
  return selected.sort((left, right) => registry.apps[left].order - registry.apps[right].order || compareText(left, right));
}

export async function publishAndroidAppProjection({ bundleRoot, appIds, targetsRoot: requestedTargetsRoot } = {}) {
  if (typeof bundleRoot !== 'string' || bundleRoot.length === 0) fail('bundleRoot is required.');
  const absoluteBundleRoot = path.resolve(bundleRoot);
  await requireRegularDirectory(absoluteBundleRoot, 'bundle root');
  const dist = path.join(absoluteBundleRoot, 'dist');
  const canonicalTargetsRoot = path.join(dist, 'targets');
  const targetsRoot = requestedTargetsRoot === undefined
    ? canonicalTargetsRoot
    : path.resolve(absoluteBundleRoot, requestedTargetsRoot);
  await requireRegularDirectory(dist, 'bundle dist directory');
  await requireRegularDirectory(canonicalTargetsRoot, 'dist/targets');
  if (!isInside(canonicalTargetsRoot, targetsRoot)) fail('targetsRoot must remain inside dist/targets.');
  await requireRegularDirectory(targetsRoot, 'Android portable targets root');

  const [registry, bundleData, expectedApiData] = await Promise.all([
    loadAppRegistry(absoluteBundleRoot),
    readRegularFile(path.join(absoluteBundleRoot, 'arcane-bundle.json'), 'arcane-bundle.json', MAX_MANIFEST_BYTES),
    readRegularFile(
      path.join(absoluteBundleRoot, 'src', 'frontend', 'shared', 'arcane-api.js'),
      'src/frontend/shared/arcane-api.js',
      MAX_MANIFEST_BYTES,
    ),
  ]);
  const bundle = parseJson(bundleData, 'arcane-bundle.json');
  if (!isPlainObject(bundle) || typeof bundle.version !== 'string' || typeof bundle.protocolVersion !== 'string') {
    fail('machine bundle identity is incomplete.');
  }
  const selected = selectedAppIds(registry, appIds);
  const projection = path.join(dist, 'android-apps');
  const staging = await fs.mkdtemp(path.join(dist, '.android-apps-stage-'));
  try {
    const packages = [];
    for (const appId of selected) {
      const verified = await verifyPortableAppPackage({
        targetsRoot,
        appId,
        configured: registry.apps[appId],
        bundle,
        expectedApiData,
      });
      const appFiles = verified.files.filter((entry) => entry.path.startsWith('app/'));
      if (appFiles.length === 0) fail(`${appId} portable target contains no Android application payload.`);
      for (const entry of appFiles) {
        await writeInside(staging, `${appId}/${entry.path}`, verified.dataByPath.get(entry.path));
      }
      await writeInside(staging, `${appId}/${ANDROID_APP_PACKAGE_MANIFEST}`, verified.packageManifestData);
      const contentManifest = Object.freeze({
        schemaVersion: 1,
        hashAlgorithm: 'sha256',
        app: Object.freeze({ id: appId, version: bundle.version }),
        files: Object.freeze(appFiles),
      });
      const contentManifestData = Buffer.from(canonicalJson(contentManifest), 'utf8');
      await writeInside(staging, `${appId}/${ANDROID_APP_CONTENT_MANIFEST}`, contentManifestData);
      packages.push(Object.freeze({
        appId,
        packageManifestData: verified.packageManifestData,
        contentManifest,
        contentManifestData,
      }));
    }
    const catalog = createCatalog({ bundle, registry, packages });
    await writeInside(staging, ANDROID_APP_CATALOG, Buffer.from(canonicalJson(catalog), 'utf8'));
    await replaceDirectoryAtomically(staging, projection, dist);
    return Object.freeze({ target: projection, catalog });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const invokedAsCli = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsCli) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node tools/build-android-app-projection.mjs [--targets-root=dist/targets/.android-portable]');
  } else if (args.length > 1 || (args.length === 1 && !args[0].startsWith('--targets-root='))) {
    console.error('Usage: node tools/build-android-app-projection.mjs [--targets-root=dist/targets/.android-portable]');
    process.exitCode = 2;
  } else {
    const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    try {
      const targetsRoot = args.length === 1 ? args[0].slice('--targets-root='.length) : undefined;
      if (targetsRoot !== undefined && targetsRoot.length === 0) fail('targetsRoot is empty.');
      const result = await publishAndroidAppProjection({ bundleRoot, targetsRoot });
      console.log(`Published ${result.catalog.apps.length} verified Android app packages at ${path.relative(bundleRoot, result.target)}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
