import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReleaseManifest } from './release-integrity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bundle = JSON.parse(await fs.readFile(path.join(root, 'arcane-bundle.json'), 'utf8'));
const platform = process.argv[2];
const outputArgument = process.argv[3];
const dist = outputArgument ? path.resolve(root, outputArgument) : path.join(root, 'dist');
const manifest = await createReleaseManifest({ dist, bundle, platform });
await fs.writeFile(path.join(dist, 'arcane-release.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote ${path.relative(root, path.join(dist, 'arcane-release.json'))} for ${platform} with ${manifest.files.length} verified files.`);
