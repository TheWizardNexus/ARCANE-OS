import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const appRoot = path.join(dist, 'app');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'arcane-bundle.json'), 'utf8'));
const windowsNative = await fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8');
const linuxNative = await fs.readFile(path.join(root, 'src/native/linux.cjs'), 'utf8');
let core = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');
core = core.replace('__ARCANE_NATIVE_ADAPTERS__', `${windowsNative}\n\n${linuxNative}`);
core = core.replace('__VERSION_JSON__', JSON.stringify(manifest.version));
core = core.replace('__BUNDLE_MANIFEST_JSON__', JSON.stringify(manifest));
new vm.Script(core, { filename: 'arcane-core.generated.cjs' });
await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
await fs.writeFile(path.join(root, 'runtime/arcane-core.cjs'), core, { mode: 0o755 });

await fs.rm(appRoot, { recursive: true, force: true });
for (const directory of ['shared', 'provisioner', 'shell']) await fs.mkdir(path.join(appRoot, directory), { recursive: true });
await fs.copyFile(path.join(root, 'src/frontend/shared/arcane-api.js'), path.join(appRoot, 'shared/arcane-api.js'));
for (const asset of ['arcane-sigil.svg', 'arcane-sigil-512.png', 'arcane-sigil.ico']) {
  await fs.copyFile(path.join(root, 'assets', asset), path.join(appRoot, 'shared', asset));
}

for (const app of ['provisioner', 'shell']) {
  const source = path.join(root, `src/frontend/${app}/index.html`);
  let html = await fs.readFile(source, 'utf8');
  const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  const scripts = scriptMatches.filter((match) => !/\bsrc\s*=/i.test(match[0])).map((match) => match[1]);
  scripts.forEach((script, index) => new vm.Script(script, { filename: `${app}.inline.${index + 1}.js` }));
  const cspScripts = [...scripts, 'window.__ARCANE_DEV_HTTP__=true;']
    .map((script) => `'sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}'`)
    .join(' ');
  if (!html.includes('__ARCANE_SCRIPT_HASHES__')) throw new Error(`${app} is missing its generated CSP script hash placeholder.`);
  html = html.replace('__ARCANE_SCRIPT_HASHES__', cspScripts);
  await fs.writeFile(path.join(appRoot, app, 'index.html'), html);
  const webManifest = {
    name: app === 'shell' ? 'Arcane OS' : 'Arcane OS Provisioner',
    short_name: app === 'shell' ? 'Arcane' : 'Arcane Provisioner',
    start_url: './index.html',
    display: 'standalone',
    background_color: '#03050a',
    theme_color: '#03050a',
    icons: [{ src: '../shared/arcane-sigil-512.png', sizes: '512x512', type: 'image/png' }],
  };
  await fs.writeFile(path.join(appRoot, app, 'manifest.webmanifest'), JSON.stringify(webManifest, null, 2));
}
new vm.Script(await fs.readFile(path.join(root, 'src/frontend/shared/arcane-api.js'), 'utf8'), { filename: 'arcane-api.js' });
await fs.copyFile(path.join(root, 'arcane-bundle.json'), path.join(dist, 'arcane-bundle.json'));
console.log(`Built Arcane Core and embedded app payload for Arcane ${manifest.version}.`);
