import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function fail(message) {
  throw new Error(`Invalid Arcane Android distribution assets: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function flavorFor(appId) {
  if (!APP_ID.test(appId)) fail(`application identifier "${appId}" is invalid.`);
  return appId.replaceAll('-', '_');
}

function packageNameFor(appId) {
  return `os.arcane.app.${flavorFor(appId)}`;
}

function networkAccessFor(descriptor) {
  const security = descriptor?.security;
  if (!security || typeof security !== 'object' || Array.isArray(security)) {
    fail('application security metadata is unavailable.');
  }
  return ['connectOrigins', 'frameOrigins', 'mediaOrigins']
    .some((key) => Array.isArray(security[key]) && security[key].length > 0);
}

async function requireDirectory(candidate, label) {
  const stat = await fs.lstat(candidate).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unavailable.`);
}

async function replaceDirectory(staging, target, parent) {
  if (!isInside(parent, staging) || !isInside(parent, target) || staging === parent || target === parent) {
    fail('publication target escapes the bundle dist directory.');
  }
  const backup = path.join(parent, `.android-build-assets-backup-${process.pid}`);
  let moved = false;
  try {
    await fs.rename(target, backup);
    moved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(staging, target);
    if (moved) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (moved) await fs.rename(backup, target).catch(() => {});
    throw error;
  }
}

export async function publishAndroidDistributionAssets({ bundleRoot } = {}) {
  if (typeof bundleRoot !== 'string' || bundleRoot.length === 0) fail('bundleRoot is required.');
  const root = path.resolve(bundleRoot);
  const dist = path.join(root, 'dist');
  const projection = path.join(dist, 'android-apps');
  await requireDirectory(projection, 'dist/android-apps projection');
  const catalog = JSON.parse(await fs.readFile(path.join(projection, 'catalog.json'), 'utf8'));
  const registry = JSON.parse(await fs.readFile(path.join(root, 'arcane-apps.json'), 'utf8'));
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.apps) || catalog.apps.length === 0) {
    fail('Android application catalog is invalid.');
  }

  const target = path.join(dist, 'android-build-assets');
  const staging = await fs.mkdtemp(path.join(dist, '.android-build-assets-stage-'));
  try {
    const launcherApps = [];
    const appIndex = [];
    const identifiers = new Set();
    for (const entry of catalog.apps) {
      const appId = entry?.id;
      if (typeof appId !== 'string' || !APP_ID.test(appId) || identifiers.has(appId)) {
        fail('Android application catalog contains an invalid or repeated application identifier.');
      }
      identifiers.add(appId);
      const descriptor = registry?.apps?.[appId];
      if (!descriptor) fail(`${appId} is absent from the application registry.`);
      const source = path.join(projection, appId);
      await requireDirectory(source, `${appId} Android application projection`);
      const flavor = flavorFor(appId);
      const packageName = packageNameFor(appId);
      const extension = path.extname(entry.icon).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) fail(`${appId} icon type is unsupported.`);
      const launcherIcon = `launcher-icons/${appId}${extension}`;
      const iconSource = path.resolve(projection, ...String(entry.icon).split('/'));
      if (!isInside(projection, iconSource)) fail(`${appId} icon escapes the Android projection.`);
      await fs.mkdir(path.dirname(path.join(staging, 'launcher', launcherIcon)), { recursive: true });
      await fs.copyFile(iconSource, path.join(staging, 'launcher', launcherIcon));

      const appTarget = path.join(staging, 'apps', flavor);
      await fs.mkdir(appTarget, { recursive: true });
      await fs.cp(source, path.join(appTarget, appId), { recursive: true, errorOnExist: true, force: false });
      await fs.writeFile(
        path.join(appTarget, 'catalog.json'),
        canonicalJson({ ...catalog, apps: [entry] }),
        { flag: 'wx' },
      );

      launcherApps.push({
        id: appId,
        displayName: entry.displayName,
        description: entry.description,
        icon: launcherIcon,
        order: entry.order,
        version: entry.version,
        packageName,
      });
      appIndex.push({
        id: appId,
        flavor,
        packageName,
        displayName: entry.displayName,
        networkAccess: networkAccessFor(descriptor),
      });
    }
    launcherApps.sort((left, right) => left.order - right.order || compareText(left.id, right.id));
    appIndex.sort((left, right) => compareText(left.id, right.id));
    await fs.mkdir(path.join(staging, 'launcher'), { recursive: true });
    await fs.writeFile(
      path.join(staging, 'launcher', 'launcher-catalog.json'),
      canonicalJson({
        schemaVersion: 1,
        protocolVersion: catalog.protocolVersion,
        bundleVersion: catalog.bundleVersion,
        apps: launcherApps,
      }),
      { flag: 'wx' },
    );
    for (const application of appIndex) {
      const appTarget = path.join(staging, 'apps', application.flavor);
      await fs.copyFile(
        path.join(staging, 'launcher', 'launcher-catalog.json'),
        path.join(appTarget, 'launcher-catalog.json'),
      );
      await fs.cp(
        path.join(staging, 'launcher', 'launcher-icons'),
        path.join(appTarget, 'launcher-icons'),
        { recursive: true, errorOnExist: true, force: false },
      );
    }
    await fs.writeFile(
      path.join(staging, 'app-index.json'),
      canonicalJson({ schemaVersion: 1, bundleVersion: catalog.bundleVersion, apps: appIndex }),
      { flag: 'wx' },
    );
    await replaceDirectory(staging, target, dist);
    return Object.freeze({ target, applications: Object.freeze(appIndex) });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const invokedAsCli = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsCli) {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    console.error('Usage: node tools/build-android-distribution-assets.mjs');
    process.exitCode = 2;
  } else {
    const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    try {
      const result = await publishAndroidDistributionAssets({ bundleRoot });
      console.log(`Published ${result.applications.length} Android application flavor payloads at ${path.relative(bundleRoot, result.target)}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
