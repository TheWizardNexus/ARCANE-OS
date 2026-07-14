import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAppContentManifest } from './app-catalog.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetsRoot = path.join(bundleRoot, 'dist', 'targets');
const target = path.resolve(process.argv[2] || '');
const appId = String(process.argv[3] || '');
const launcher = String(process.argv[4] || '');
const relative = path.relative(targetsRoot, target);
if (!appId || !launcher || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error('Refusing to write app content outside dist/targets.');
}
const result = await writeAppContentManifest({ target, appId, launcher });
console.log(JSON.stringify({ manifest: 'arcane-app-content.json', sha256: result.sha256, files: result.manifest.files.length }));
