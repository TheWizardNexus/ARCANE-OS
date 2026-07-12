import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { replaceTemplateTokenExactlyOnce } from './exact-template-replacement.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const required = [
  'runtime/arcane-core.cjs','dist/app/shared/arcane-api.js','dist/app/provisioner/index.html','dist/app/shell/index.html',
  'src/hosts/windows/ArcaneHost.cs','src/hosts/linux/arcane_host.c','src/native/windows.cjs','src/native/linux.cjs',
  'package-lock.json','VALIDATION.md'
];
for (const relative of required) await fs.access(path.join(root, relative));
new vm.Script(await fs.readFile(path.join(root, 'runtime/arcane-core.cjs'),'utf8'), { filename:'arcane-core.cjs' });
new vm.Script(await fs.readFile(path.join(root, 'dist/app/shared/arcane-api.js'),'utf8'), { filename:'arcane-api.js' });
for (const app of ['provisioner','shell']) {
  const html = await fs.readFile(path.join(root, `dist/app/${app}/index.html`),'utf8');
  for (const [index, match] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].entries()) new vm.Script(match[1], { filename:`${app}-${index}.js` });
}
const coreText = await fs.readFile(path.join(root,'runtime/arcane-core.cjs'),'utf8');
const bundleManifest = JSON.parse(await fs.readFile(path.join(root, 'arcane-bundle.json'), 'utf8'));
let expectedCore = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');
const windowsNative = await fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8');
const linuxNative = await fs.readFile(path.join(root, 'src/native/linux.cjs'), 'utf8');
expectedCore = replaceTemplateTokenExactlyOnce(expectedCore, '__ARCANE_NATIVE_ADAPTERS__', `${windowsNative}\n\n${linuxNative}`);
expectedCore = replaceTemplateTokenExactlyOnce(expectedCore, '__VERSION_JSON__', JSON.stringify(bundleManifest.version));
expectedCore = replaceTemplateTokenExactlyOnce(expectedCore, '__BUNDLE_MANIFEST_JSON__', JSON.stringify(bundleManifest));
if (coreText !== expectedCore) throw new Error('Generated Arcane Core has drifted from its template, native adapters, or bundle manifest. Run npm run build.');
if (!coreText.includes('Content-Length: ${body.length}\\r\\n\\r\\n')) throw new Error('Framed RPC encoder is missing.');
if (!coreText.includes('arcane-privileged-')) throw new Error('Privileged pipe/socket broker is missing.');

const windowsHost = await fs.readFile(path.join(root, 'src/hosts/windows/ArcaneHost.cs'), 'utf8');
if (!windowsHost.includes('internal ArcaneBridge(ArcaneCoreProcess coreProcess)')) throw new Error('Windows host accessibility regression: ArcaneBridge constructor must be internal.');
if (windowsHost.includes('public ArcaneBridge(ArcaneCoreProcess coreProcess)')) throw new Error('Windows host would fail with CS0051 because a public constructor exposes ArcaneCoreProcess.');
for (const token of ['SetCurrentProcessExplicitAppUserModelID','AddHostObjectToScript("arcaneBridge"','PostWebMessageAsJson','SetVirtualHostNameToFolderMapping']) {
  if (!windowsHost.includes(token)) throw new Error(`Windows WebView2 host feature missing: ${token}`);
}
if (!windowsHost.includes('public string Send(string requestJson)')) throw new Error('Windows bridge must expose Send through COM.');
if (windowsHost.includes('public string Invoke(string requestJson)')) throw new Error('Windows bridge uses COM-reserved method name Invoke.');
const linuxHost = await fs.readFile(path.join(root, 'src/hosts/linux/arcane_host.c'), 'utf8');
for (const token of ['webkit_user_content_manager_register_script_message_handler_with_reply','script-message-with-reply-received::arcane','JSCValue *value','webkit_web_view_evaluate_javascript']) {
  if (!linuxHost.includes(token)) throw new Error(`Linux WebKitGTK host feature missing: ${token}`);
}
if (linuxHost.includes('WebKitJavascriptResult *js_result')) throw new Error('Linux reply-capable bridge is using the obsolete callback value type.');

const apiText = await fs.readFile(path.join(root,'dist/app/shared/arcane-api.js'),'utf8');
for (const token of ['hostObjects.arcaneBridge','messageHandlers.arcane','DevelopmentHttpTransport']) if (!apiText.includes(token)) throw new Error(`Transport missing: ${token}`);
if (!apiText.includes('this.bridge.Send(JSON.stringify(request))')) throw new Error('Generated WebView2 transport must call ArcaneBridge.Send.');
if (apiText.includes('this.bridge.Invoke(JSON.stringify(request))')) throw new Error('Generated WebView2 transport still calls COM-reserved Invoke.');

function methodLiterals(text, expression, label, allowAliases = false) {
  const values = [...text.matchAll(expression)].map((match) => match[1]);
  if (!values.length) throw new Error(label + ' exposes no Arcane API methods.');
  if (!allowAliases && new Set(values).size !== values.length) throw new Error(label + ' repeats an Arcane API method.');
  return [...new Set(values)].sort();
}
const policyStart = coreText.indexOf('const METHOD_POLICIES = Object.freeze({');
const policyEnd = coreText.indexOf('\n});', policyStart);
const dispatchStart = coreText.indexOf('async function dispatchMethod(request, options)');
const dispatchEnd = coreText.indexOf('\nfunction normalizeResponseError', dispatchStart);
if (policyStart < 0 || policyEnd < 0 || dispatchStart < 0 || dispatchEnd < 0) throw new Error('Arcane API policy or dispatch boundary is missing.');
const frontendMethods = methodLiterals(apiText, /\binvoke\('([^']+)'/g, 'Frontend API', true);
const policyMethods = methodLiterals(coreText.slice(policyStart, policyEnd), /^\s*'([^']+)'\s*:/gm, 'Core policy');
const dispatchMethods = methodLiterals(coreText.slice(dispatchStart, dispatchEnd), /\bcase '([^']+)':/g, 'Core dispatch');
if (JSON.stringify(frontendMethods) !== JSON.stringify(policyMethods) || JSON.stringify(frontendMethods) !== JSON.stringify(dispatchMethods)) {
  throw new Error('Arcane frontend, capability policy, and Core dispatch method sets have drifted.');
}

for (const launcher of ['start-provisioner.bat','start-provisioner-debug.bat','start-shell.bat']) {
  const launcherText = await fs.readFile(path.join(root, launcher), 'utf8');
  if (!launcherText.includes('dist\\windows\\bin\\Arcane')) throw new Error(`${launcher} does not target the sealed Windows bin directory.`);
}
for (const launcher of ['start-provisioner-simulation.bat','start-shell-simulation.bat']) {
  const launcherText = await fs.readFile(path.join(root, launcher), 'utf8');
  if (!launcherText.includes('dist\\windows\\bin\\Arcane')) throw new Error(launcher + ' does not target the sealed Windows bin directory.');
  if (!launcherText.includes('--simulate') || !launcherText.includes('--allow-unsigned-local-release')) {
    throw new Error(launcher + ' does not explicitly contain simulation inside the unsigned-local release boundary.');
  }
}
console.log('Arcane source and generated payload verification passed.');
