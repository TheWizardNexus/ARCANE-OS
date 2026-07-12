import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetsRoot = path.join(bundleRoot, 'dist', 'targets');
const target = path.resolve(process.argv[2] || '');
const appId = String(process.argv[3] || '');
const launcher = String(process.argv[4] || '');
const signatureStatus = String(process.argv[5] || 'NotSigned');
const relativeTarget = path.relative(targetsRoot, target);
if (!appId || !launcher || relativeTarget.startsWith(`..${path.sep}`) || relativeTarget === '..' || path.isAbsolute(relativeTarget)) {
  throw new Error('Refusing to finalize an app package outside dist/targets.');
}

const manifestPath = path.join(target, 'arcane-app-package.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (manifest.app?.id !== appId) throw new Error('Target app manifest identity mismatch.');
for (const required of [launcher, 'ArcaneCore.exe', 'ArcanePipeGuard.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']) {
  await fs.access(path.join(target, required));
}

const files = [];
async function visit(directory, relativeDirectory = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Native app package contains a symbolic link: ${relative}.`);
    if (entry.isDirectory()) await visit(absolute, relative);
    else if (entry.isFile() && relative !== 'arcane-app-package.json') {
      const data = await fs.readFile(absolute);
      files.push({ path: relative, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    } else if (!entry.isFile()) throw new Error(`Native app package contains an unsupported entry: ${relative}.`);
  }
}
await visit(target);
files.sort((left, right) => left.path.localeCompare(right.path, 'en'));

const finalized = {
  ...manifest,
  platform: 'windows',
  architecture: 'x64',
  native: {
    launcher,
    core: 'ArcaneCore.exe',
    pipeGuard: 'ArcanePipeGuard.exe',
    renderer: 'WebView2',
    signatureStatus,
    signatureRequiredForDistribution: true,
  },
  files,
};
const temporary = `${manifestPath}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(finalized, null, 2)}\n`, { flag: 'wx' });
await fs.rename(temporary, manifestPath);
console.log(`Finalized native Arcane app package ${appId} with ${files.length} verified files.`);
