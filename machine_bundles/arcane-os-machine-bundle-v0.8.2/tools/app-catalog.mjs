import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadAppRegistry, normalizeRelativePath } from './app-packager-lib.mjs';

export const APP_CONTENT_MANIFEST = 'arcane-app-content.json';
export const APP_PACKAGE_MANIFEST = 'arcane-app-package.json';
export const APP_CATALOG = 'catalog.json';

const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_APP_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TARGET_ROOT_DIRECTORY = 'app';
const TARGET_BASE_FILES = Object.freeze([
  'arcane-bundle.json',
  APP_PACKAGE_MANIFEST,
  'ArcaneCore.exe',
  'ArcanePipeGuard.exe',
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll',
  'WebView2Loader.dll',
]);

function fail(message) {
  throw new Error(`Invalid Arcane installed-app package: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unknown field "${key}".`);
  }
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

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function validateAppId(value, label = 'app id') {
  if (typeof value !== 'string' || value.length > 64 || !APP_ID_PATTERN.test(value) || WINDOWS_RESERVED_APP_ID.test(value)) {
    fail(`${label} is invalid or reserved.`);
  }
  return value;
}

function expectedLauncher(appId) {
  return `ArcaneApp-${appId}.exe`;
}

function validateLauncher(appId, launcher) {
  if (launcher !== expectedLauncher(appId)) fail(`the ${appId} launcher name is not canonical.`);
  return launcher;
}

function exactNames(actual, expected) {
  const left = [...actual].sort(compareText);
  const right = [...expected].sort(compareText);
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

async function assertExactTargetLayout(target, appId, launcher, phase) {
  const rootStat = await fs.lstat(target);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('target root must be a regular directory.');
  const entries = await fs.readdir(target, { withFileTypes: true });
  const names = entries.map((entry) => entry.name);
  const expected = [TARGET_ROOT_DIRECTORY, ...TARGET_BASE_FILES];
  if (phase === 'write') {
    if (names.includes(APP_CONTENT_MANIFEST)) expected.push(APP_CONTENT_MANIFEST);
    if (names.includes(launcher)) expected.push(launcher);
  } else {
    expected.push(APP_CONTENT_MANIFEST, launcher);
  }
  if (!exactNames(names, expected)) {
    fail(phase === 'write'
      ? `${appId} pre-wrapper target root contains missing or unexpected entries.`
      : `${appId} finalized target root contains missing or unexpected entries.`);
  }
  for (const entry of entries) {
    const absolute = path.join(target, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) fail(`${appId} target root contains symbolic link "${entry.name}".`);
    if (entry.name === TARGET_ROOT_DIRECTORY) {
      if (!entry.isDirectory() || !stat.isDirectory()) fail(`${appId} target app payload is not a regular directory.`);
    } else if (!entry.isFile() || !stat.isFile()) {
      fail(`${appId} target root entry "${entry.name}" is not a regular file.`);
    }
  }
}

async function enumerateHashedFiles(root, excluded = new Set()) {
  const files = [];
  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length === 0) fail(`package contains empty directory "${relativeDirectory || '.'}".`);
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`package contains symbolic link "${relative}".`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        if (excluded.has(relative)) continue;
        const data = await fs.readFile(absolute);
        files.push({ path: relative, size: data.length, sha256: sha256(data) });
      } else {
        fail(`package contains unsupported filesystem entry "${relative}".`);
      }
    }
  }
  await visit(root);
  files.sort((left, right) => compareText(left.path, right.path));
  return files;
}

function validateFileInventory(files, label) {
  if (!Array.isArray(files) || files.length === 0) fail(`${label} must contain files.`);
  const normalized = files.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    assertOnlyKeys(entry, new Set(['path', 'size', 'sha256']), entryLabel);
    const relative = normalizeRelativePath(entry.path, `${entryLabel}.path`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail(`${entryLabel}.size is invalid.`);
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) fail(`${entryLabel}.sha256 is invalid.`);
    return { path: relative, size: entry.size, sha256: entry.sha256 };
  });
  const paths = normalized.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) fail(`${label} contains duplicate paths.`);
  const sorted = [...paths].sort(compareText);
  if (paths.some((entry, index) => entry !== sorted[index])) fail(`${label} must be sorted by canonical path.`);
  return normalized;
}

function inventoriesEqual(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index].path
    && entry.size === right[index].size
    && entry.sha256 === right[index].sha256
  ));
}

function parseContentManifest(data, { appId, version }) {
  let manifest;
  try {
    manifest = JSON.parse(data.toString('utf8'));
  } catch {
    fail(`${APP_CONTENT_MANIFEST} is not valid JSON.`);
  }
  assertOnlyKeys(manifest, new Set(['schemaVersion', 'hashAlgorithm', 'app', 'files']), APP_CONTENT_MANIFEST);
  if (manifest.schemaVersion !== 1) fail(`${APP_CONTENT_MANIFEST} schema version must be 1.`);
  if (manifest.hashAlgorithm !== 'sha256') fail(`${APP_CONTENT_MANIFEST} must use SHA-256.`);
  assertOnlyKeys(manifest.app, new Set(['id', 'version']), `${APP_CONTENT_MANIFEST}.app`);
  if (manifest.app.id !== appId) fail(`${APP_CONTENT_MANIFEST} app identity does not match ${appId}.`);
  if (manifest.app.version !== version) fail(`${APP_CONTENT_MANIFEST} version does not match ${version}.`);
  return { ...manifest, files: validateFileInventory(manifest.files, `${APP_CONTENT_MANIFEST}.files`) };
}

export async function writeAppContentManifest({ target, appId, launcher = expectedLauncher(appId) }) {
  const absoluteTarget = path.resolve(target);
  validateAppId(appId);
  validateLauncher(appId, launcher);
  await assertExactTargetLayout(absoluteTarget, appId, launcher, 'write');
  const packageData = await fs.readFile(path.join(absoluteTarget, APP_PACKAGE_MANIFEST));
  const packageManifest = JSON.parse(packageData.toString('utf8'));
  if (packageManifest.app?.id !== appId) fail(`the outer package identity does not match ${appId}.`);
  if (typeof packageManifest.bundleVersion !== 'string' || !packageManifest.bundleVersion) fail('the outer package version is missing.');
  const excluded = new Set([APP_CONTENT_MANIFEST, APP_PACKAGE_MANIFEST, launcher]);
  const files = await enumerateHashedFiles(absoluteTarget, excluded);
  const manifest = {
    schemaVersion: 1,
    hashAlgorithm: 'sha256',
    app: { id: appId, version: packageManifest.bundleVersion },
    files,
  };
  const data = Buffer.from(canonicalJson(manifest), 'utf8');
  await fs.writeFile(path.join(absoluteTarget, APP_CONTENT_MANIFEST), data);
  return Object.freeze({ manifest, data, sha256: sha256(data) });
}

export async function verifyAppContentManifest({ target, appId, launcher = expectedLauncher(appId), version }) {
  const absoluteTarget = path.resolve(target);
  validateAppId(appId);
  validateLauncher(appId, launcher);
  await assertExactTargetLayout(absoluteTarget, appId, launcher, 'verify');
  const data = await fs.readFile(path.join(absoluteTarget, APP_CONTENT_MANIFEST));
  const manifest = parseContentManifest(data, { appId, version });
  const excluded = new Set([APP_CONTENT_MANIFEST, APP_PACKAGE_MANIFEST, launcher]);
  const actual = await enumerateHashedFiles(absoluteTarget, excluded);
  if (!inventoriesEqual(manifest.files, actual)) fail(`${APP_CONTENT_MANIFEST} does not exactly match the target content.`);
  return Object.freeze({ manifest, data, sha256: sha256(data) });
}

async function verifyOuterPackage(target, packageManifest, packageData) {
  const appId = validateAppId(packageManifest && packageManifest.app && packageManifest.app.id, 'package app id');
  const launcher = expectedLauncher(appId);
  await assertExactTargetLayout(path.resolve(target), appId, launcher, 'verify');
  if (!Array.isArray(packageManifest.files)) fail(`${APP_PACKAGE_MANIFEST} has no file inventory.`);
  const expected = validateFileInventory(packageManifest.files, `${APP_PACKAGE_MANIFEST}.files`);
  const actual = await enumerateHashedFiles(target, new Set([APP_PACKAGE_MANIFEST]));
  if (!inventoriesEqual(expected, actual)) fail(`${APP_PACKAGE_MANIFEST} does not exactly match the native target package.`);
  return Object.freeze({ manifest: packageManifest, data: packageData, sha256: sha256(packageData) });
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function createInstalledAppCatalog({ bundle, registry, packages }) {
  if (!isPlainObject(bundle) || typeof bundle.version !== 'string' || typeof bundle.protocolVersion !== 'string') {
    fail('the machine bundle identity is incomplete.');
  }
  if (!registry?.apps || !Array.isArray(packages) || packages.length === 0) fail('catalog input is incomplete.');
  const seen = new Set();
  const apps = packages.map((item) => {
    const appId = validateAppId(item.appId);
    if (seen.has(appId)) fail(`catalog input repeats app "${appId}".`);
    seen.add(appId);
    const configured = registry.apps[appId];
    if (!configured) fail(`catalog input contains unregistered app "${appId}".`);
    const packaged = item.packageManifest;
    if (!isPlainObject(packaged) || packaged.platform !== 'windows' || packaged.architecture !== 'x64') {
      fail(`${appId} is not a finalized Windows x64 app package.`);
    }
    if (packaged.schemaVersion !== 1 || packaged.bundleVersion !== bundle.version || packaged.protocolVersion !== bundle.protocolVersion) {
      fail(`${appId} package identity does not match the machine bundle.`);
    }
    if (
      packaged.app?.id !== appId
      || packaged.app.type !== 'app'
      || packaged.app.displayName !== configured.displayName
      || packaged.app.description !== configured.description
      || packaged.app.icon !== configured.icon
      || packaged.app.order !== configured.order
    ) fail(`${appId} presentation metadata does not match the validated registry.`);
    if (!arraysEqual(packaged.app.capabilities, configured.capabilities)) {
      fail(`${appId} capabilities do not exactly match the non-privileged registry allowlist.`);
    }
    if (packaged.native?.launcher !== expectedLauncher(appId)) fail(`${appId} has a non-canonical native launcher.`);
    if (!['NotSigned', 'Valid'].includes(packaged.native?.signatureStatus)) fail(`${appId} has an invalid signature state.`);
    if (!Buffer.isBuffer(item.packageManifestData) || !Buffer.isBuffer(item.contentManifestData)) {
      fail(`${appId} manifest bytes are missing.`);
    }
    const content = parseContentManifest(item.contentManifestData, { appId, version: bundle.version });
    const packagedIcon = `app/${appId}/${configured.icon}`;
    if (!content.files.some((entry) => entry.path === packagedIcon)) fail(`${appId} content manifest omits its configured icon.`);
    return {
      id: appId,
      displayName: configured.displayName,
      description: configured.description,
      icon: `${appId}/${packagedIcon}`,
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
  if (!isInside(parent, staging) || !isInside(parent, target) || target === parent) fail('runtime projection path escapes dist.');
  const backup = path.join(parent, `.apps-backup-${process.pid}`);
  if (!isInside(parent, backup)) fail('runtime projection backup path escapes dist.');
  await fs.rm(backup, { recursive: true, force: true });
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
    if (!(await exists(target)) && movedExisting) await fs.rename(backup, target);
    throw error;
  }
}

export async function publishWindowsAppProjection({ bundleRoot, appIds }) {
  const absoluteBundleRoot = path.resolve(bundleRoot);
  const registry = await loadAppRegistry(absoluteBundleRoot);
  const bundle = JSON.parse(await fs.readFile(path.join(absoluteBundleRoot, 'arcane-bundle.json'), 'utf8'));
  if (!Array.isArray(appIds) || appIds.length === 0 || new Set(appIds).size !== appIds.length) {
    fail('runtime projection app ids must be a non-empty unique array.');
  }
  const dist = path.join(absoluteBundleRoot, 'dist');
  const targetsRoot = path.join(dist, 'targets');
  const projection = path.join(dist, 'apps');
  const staging = path.join(dist, `.apps-stage-${process.pid}`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: false });
  try {
    const packages = [];
    for (const appId of appIds) {
      validateAppId(appId);
      if (!registry.apps[appId]) fail(`runtime projection contains unregistered app "${appId}".`);
      const target = path.join(targetsRoot, appId);
      if (!isInside(targetsRoot, target)) fail('target path escapes dist/targets.');
      const packageManifestData = await fs.readFile(path.join(target, APP_PACKAGE_MANIFEST));
      const packageManifest = JSON.parse(packageManifestData.toString('utf8'));
      const outer = await verifyOuterPackage(target, packageManifest, packageManifestData);
      const content = await verifyAppContentManifest({
        target,
        appId,
        launcher: expectedLauncher(appId),
        version: bundle.version,
      });
      packages.push({
        appId,
        packageManifest: outer.manifest,
        packageManifestData: outer.data,
        contentManifestData: content.data,
      });
      await fs.cp(target, path.join(staging, appId), { recursive: true, force: false, errorOnExist: true, dereference: false });
    }
    const catalog = createInstalledAppCatalog({ bundle, registry, packages });
    const catalogData = canonicalJson(catalog);
    if (/launcher|executable|arguments|\bargs\b/i.test(catalogData)) fail('catalog exposes executable launch details.');
    await fs.writeFile(path.join(staging, APP_CATALOG), catalogData, { flag: 'wx' });
    await replaceDirectoryAtomically(staging, projection, dist);
    return Object.freeze({ target: projection, catalog });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyWindowsAppProjection({ bundleRoot, appIds }) {
  const absoluteBundleRoot = path.resolve(bundleRoot);
  const registry = await loadAppRegistry(absoluteBundleRoot);
  const bundle = JSON.parse(await fs.readFile(path.join(absoluteBundleRoot, 'arcane-bundle.json'), 'utf8'));
  if (!Array.isArray(appIds) || appIds.length === 0 || new Set(appIds).size !== appIds.length) {
    fail('runtime projection app ids must be a non-empty unique array.');
  }
  const projection = path.join(absoluteBundleRoot, 'dist', 'apps');
  const topLevel = await fs.readdir(projection, { withFileTypes: true });
  const expectedNames = [APP_CATALOG, ...appIds].sort(compareText);
  const actualNames = topLevel.map((entry) => entry.name).sort(compareText);
  if (actualNames.length !== expectedNames.length || actualNames.some((entry, index) => entry !== expectedNames[index])) {
    fail('runtime projection contains missing or unexpected top-level entries.');
  }
  for (const entry of topLevel) {
    if (entry.isSymbolicLink()) fail(`runtime projection contains symbolic link "${entry.name}".`);
    if (entry.name === APP_CATALOG && !entry.isFile()) fail(`${APP_CATALOG} is not a regular file.`);
    if (entry.name !== APP_CATALOG && !entry.isDirectory()) fail(`${entry.name} runtime projection is not a directory.`);
  }
  const packages = [];
  for (const appId of appIds) {
    validateAppId(appId);
    if (!registry.apps[appId]) fail(`runtime projection contains unregistered app "${appId}".`);
    const target = path.join(projection, appId);
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${appId} runtime projection is not a regular directory.`);
    const packageManifestData = await fs.readFile(path.join(target, APP_PACKAGE_MANIFEST));
    const packageManifest = JSON.parse(packageManifestData.toString('utf8'));
    const outer = await verifyOuterPackage(target, packageManifest, packageManifestData);
    const content = await verifyAppContentManifest({
      target,
      appId,
      launcher: expectedLauncher(appId),
      version: bundle.version,
    });
    packages.push({
      appId,
      packageManifest: outer.manifest,
      packageManifestData: outer.data,
      contentManifestData: content.data,
    });
  }
  const expected = createInstalledAppCatalog({ bundle, registry, packages });
  const actualData = await fs.readFile(path.join(projection, APP_CATALOG), 'utf8');
  if (actualData !== canonicalJson(expected)) fail('runtime app catalog is not the canonical catalog for its verified packages.');
  return Object.freeze({ target: projection, catalog: expected });
}
