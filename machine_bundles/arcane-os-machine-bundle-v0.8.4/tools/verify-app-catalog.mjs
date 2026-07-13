import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTargetApps } from './app-packager-lib.mjs';
import { verifyWindowsAppProjection } from './app-catalog.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apps = await listTargetApps(bundleRoot);
const verified = await verifyWindowsAppProjection({ bundleRoot, appIds: apps.map((app) => app.id) });
console.log(`Verified installed-app catalog with ${verified.catalog.apps.length} exact native app projections.`);
