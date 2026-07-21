import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { replaceTemplateTokenExactlyOnce } from './exact-template-replacement.mjs';
import { readMethodPolicies, renderCoreMethodPolicies } from './method-policies.mjs';
import { readMethodContracts, renderCoreMethodContracts } from './method-contracts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const appRoot = path.join(dist, 'app');
const platformPresentationSource = path.resolve(root, '../../arcane/modules/SystemPlatformPresentation.js');
const sharedArcaneRoot = path.resolve(root, '../../arcane');
const nativeThemeFiles = Object.freeze([
  'css/theme.css',
  'entities/Preference.js',
  'entities/Theme.js',
  'modules/AppDataScope.js',
  'modules/AppearancePreferences.js',
  'modules/PreferenceStore.js',
  'modules/SystemAppearance.js',
  'modules/ThemeBootstrap.js',
  'modules/ThemeManager.js',
]);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'arcane-bundle.json'), 'utf8'));
const methodPolicies = await readMethodPolicies(root);
const methodContracts = await readMethodContracts(root, methodPolicies);
const windowsNative = await fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8');
const linuxNative = await fs.readFile(path.join(root, 'src/native/linux.cjs'), 'utf8');
const platformAdapters = await fs.readFile(path.join(root, 'src/native/platform-adapters.cjs'), 'utf8');
let core = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');
core = replaceTemplateTokenExactlyOnce(core, '__ARCANE_NATIVE_ADAPTERS__', `${windowsNative}\n\n${linuxNative}\n\n${platformAdapters}`);
core = replaceTemplateTokenExactlyOnce(core, '__ARCANE_METHOD_POLICIES__', renderCoreMethodPolicies(methodPolicies));
core = replaceTemplateTokenExactlyOnce(core, '__ARCANE_METHOD_CONTRACTS__', renderCoreMethodContracts(methodContracts, methodPolicies));
core = replaceTemplateTokenExactlyOnce(core, '__VERSION_JSON__', JSON.stringify(manifest.version));
core = replaceTemplateTokenExactlyOnce(core, '__BUNDLE_MANIFEST_JSON__', JSON.stringify(manifest));
new vm.Script(core, { filename: 'arcane-core.generated.cjs' });
await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
await fs.writeFile(path.join(root, 'runtime/arcane-core.cjs'), core, { mode: 0o755 });

await fs.rm(appRoot, { recursive: true, force: true });
for (const directory of ['shared', 'provisioner', 'shell']) await fs.mkdir(path.join(appRoot, directory), { recursive: true });
await fs.copyFile(path.join(root, 'src/frontend/shared/arcane-api.js'), path.join(appRoot, 'shared/arcane-api.js'));
await fs.copyFile(platformPresentationSource, path.join(appRoot, 'shared/SystemPlatformPresentation.js'));
for (const relativePath of nativeThemeFiles) {
  const target = path.join(appRoot, 'arcane', ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(sharedArcaneRoot, ...relativePath.split('/')), target);
}
for (const asset of ['arcane-sigil.svg', 'arcane-sigil-512.png', 'arcane-sigil.ico', 'arcane-lock-screen-v1.png']) {
  await fs.copyFile(path.join(root, 'assets', asset), path.join(appRoot, 'shared', asset));
}
for (const modelFile of ['Arcane-20B.Modelfile', 'Arcane-120B.Modelfile']) {
  await fs.copyFile(
    path.resolve(root, '../../arcane/models', modelFile),
    path.join(appRoot, 'shared', modelFile),
  );
}

for (const app of ['provisioner', 'shell']) {
  const source = path.join(root, `src/frontend/${app}/index.html`);
  let html = await fs.readFile(source, 'utf8');
  html = html.replace(/\r\n?/g, '\n');
  const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  const scripts = scriptMatches.filter((match) => !/\bsrc\s*=/i.test(match[0])).map((match) => match[1]);
  scripts.forEach((script, index) => new vm.Script(script, { filename: `${app}.inline.${index + 1}.js` }));
  const cspScripts = [...scripts, 'window.__ARCANE_DEV_HTTP__=true;']
    .map((script) => `'sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}'`)
    .join(' ');
  html = replaceTemplateTokenExactlyOnce(html, '__ARCANE_SCRIPT_HASHES__', cspScripts);
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
new vm.Script(await fs.readFile(platformPresentationSource, 'utf8'), { filename: 'SystemPlatformPresentation.js' });
await fs.copyFile(path.join(root, 'arcane-bundle.json'), path.join(dist, 'arcane-bundle.json'));
console.log(`Built Arcane Core and embedded app payload for Arcane ${manifest.version}.`);
