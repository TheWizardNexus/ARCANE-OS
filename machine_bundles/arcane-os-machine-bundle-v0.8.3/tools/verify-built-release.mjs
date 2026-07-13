import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseManifest } from './release-integrity.mjs';
import { verifyMachineContentManifest } from './machine-content.mjs';
import { verifyWindowsDpiExecutable } from './verify-windows-dpi.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node tools/verify-built-release.mjs <release-root>');
const bundle = JSON.parse(await fs.readFile(path.join(bundleRoot, 'arcane-bundle.json'), 'utf8'));
const releaseBundleText = await fs.readFile(path.join(releaseRoot, 'arcane-bundle.json'), 'utf8');
const releaseBundle = JSON.parse(releaseBundleText);
const canonicalReleaseBundle = JSON.stringify(releaseBundle, null, 2);
if (releaseBundleText !== canonicalReleaseBundle && releaseBundleText !== `${canonicalReleaseBundle}\n`) {
  throw new Error('Invalid Windows distribution: arcane-bundle.json is not canonical JSON.');
}
const manifest = JSON.parse(await fs.readFile(path.join(releaseRoot, 'arcane-release.json'), 'utf8'));
const [outer, content] = await Promise.all([
  verifyReleaseManifest({ dist: releaseRoot, manifest, platform: 'windows', version: bundle.version }),
  verifyMachineContentManifest({ releaseRoot, version: bundle.version }),
]);
await Promise.all([
  verifyWindowsDpiExecutable(path.join(releaseRoot, 'bin', 'ArcaneProvisioner.exe')),
  verifyWindowsDpiExecutable(path.join(releaseRoot, 'bin', 'ArcaneShell.exe')),
]);
console.log(`Verified Windows distribution: ${outer.length} outer files, ${content.manifest.files.length} publisher-bound content files, ${content.sha256}.`);
