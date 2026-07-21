import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTargetApp, listTargetApps } from './app-packager-lib.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(bundleRoot, 'dist', 'targets', '.android-portable');
const argumentsProvided = process.argv.slice(2);

if (argumentsProvided.length !== 0) {
  console.error('Usage: node tools/build-android-portable-apps.mjs');
  process.exitCode = 2;
} else {
  await fs.mkdir(outputRoot, { recursive: true });
  const applications = await listTargetApps(bundleRoot);
  for (const application of applications) {
    const result = await buildTargetApp({
      bundleRoot,
      appId: application.id,
      outputRoot,
    });
    console.log(`Built isolated Android portable app package for ${result.app}.`);
  }
}
