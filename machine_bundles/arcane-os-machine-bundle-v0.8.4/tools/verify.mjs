import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { replaceTemplateTokenExactlyOnce } from './exact-template-replacement.mjs';
import { readMethodContracts, renderAndroidMethodContracts, renderCoreMethodContracts } from './method-contracts.mjs';
import { readMethodPolicies, renderAndroidApplicationRegistry, renderAndroidCapabilityRegistry, renderCoreMethodPolicies } from './method-policies.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const required = [
  'runtime/arcane-core.cjs','dist/app/shared/arcane-api.js','dist/app/shared/Arcane-20B.Modelfile','dist/app/shared/Arcane-120B.Modelfile','dist/app/provisioner/index.html','dist/app/shell/index.html',
  'src/api/method-contracts.json','src/api/method-policies.json','src/api/shared-method-contract-fixtures.json','src/hosts/windows/ArcaneHost.cs','src/hosts/windows/ArcaneHost.manifest','src/hosts/linux/arcane_host.c','src/hosts/android/AndroidBridgeProtocol.kt','src/hosts/android/ArcaneAndroidHostSession.kt','src/hosts/android/ArcaneAndroidSystemAdapter.kt','src/hosts/android/ArcaneWebViewBridge.kt','src/hosts/android/ArcaneWebViewHostController.kt','src/hosts/android/GeneratedAndroidApplicationRegistry.kt','src/hosts/android/GeneratedAndroidCapabilityRegistry.kt','src/hosts/android/GeneratedAndroidMethodContracts.kt','src/native/windows.cjs','src/native/linux.cjs','src/native/platform-adapters.cjs',
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
for (const modelFile of ['Arcane-20B.Modelfile','Arcane-120B.Modelfile']) {
  const sourceModel = await fs.readFile(path.resolve(root,'../../arcane/models',modelFile));
  const builtModel = await fs.readFile(path.join(root,'dist/app/shared',modelFile));
  if (!sourceModel.equals(builtModel)) throw new Error(`The packaged Arcane model definition has drifted from arcane/models/${modelFile}. Run npm run build.`);
}
const bundleManifest = JSON.parse(await fs.readFile(path.join(root, 'arcane-bundle.json'), 'utf8'));
const appRegistry = JSON.parse(await fs.readFile(path.join(root, 'arcane-apps.json'), 'utf8'));
const methodPolicies = await readMethodPolicies(root);
const methodContracts = await readMethodContracts(root, methodPolicies);
let expectedCore = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');
const windowsNative = await fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8');
const linuxNative = await fs.readFile(path.join(root, 'src/native/linux.cjs'), 'utf8');
const platformAdapters = await fs.readFile(path.join(root, 'src/native/platform-adapters.cjs'), 'utf8');
expectedCore = replaceTemplateTokenExactlyOnce(expectedCore, '__ARCANE_NATIVE_ADAPTERS__', `${windowsNative}\n\n${linuxNative}\n\n${platformAdapters}`);
expectedCore = replaceTemplateTokenExactlyOnce(expectedCore, '__ARCANE_METHOD_POLICIES__', renderCoreMethodPolicies(methodPolicies));
expectedCore = replaceTemplateTokenExactlyOnce(expectedCore, '__ARCANE_METHOD_CONTRACTS__', renderCoreMethodContracts(methodContracts, methodPolicies));
expectedCore = replaceTemplateTokenExactlyOnce(expectedCore, '__VERSION_JSON__', JSON.stringify(bundleManifest.version));
expectedCore = replaceTemplateTokenExactlyOnce(expectedCore, '__BUNDLE_MANIFEST_JSON__', JSON.stringify(bundleManifest));
if (coreText !== expectedCore) throw new Error('Generated Arcane Core has drifted from its template, native adapters, or bundle manifest. Run npm run build.');
const generatedAndroidRegistry = await fs.readFile(path.join(root, 'src/hosts/android/GeneratedAndroidCapabilityRegistry.kt'), 'utf8');
if (generatedAndroidRegistry !== renderAndroidCapabilityRegistry(methodPolicies)) throw new Error('Generated Android capability registry has drifted from src/api/method-policies.json.');
const generatedAndroidApplications = await fs.readFile(path.join(root, 'src/hosts/android/GeneratedAndroidApplicationRegistry.kt'), 'utf8');
if (generatedAndroidApplications !== renderAndroidApplicationRegistry(bundleManifest, methodPolicies)) throw new Error('Generated Android application registry has drifted from arcane-bundle.json or src/api/method-policies.json.');
const generatedAndroidContracts = await fs.readFile(path.join(root, 'src/hosts/android/GeneratedAndroidMethodContracts.kt'), 'utf8');
if (generatedAndroidContracts !== renderAndroidMethodContracts(methodContracts, methodPolicies)) throw new Error('Generated Android semantic contract registry has drifted from src/api/method-contracts.json.');
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
const registryMethods = Object.keys(methodPolicies).sort();
if (JSON.stringify(frontendMethods) !== JSON.stringify(policyMethods) || JSON.stringify(frontendMethods) !== JSON.stringify(dispatchMethods) || JSON.stringify(frontendMethods) !== JSON.stringify(registryMethods)) {
  throw new Error('Arcane frontend, canonical capability registry, generated Core policy, and dispatch method sets have drifted.');
}
const descriptors = [...Object.entries(bundleManifest.apps || {}), ...Object.entries(appRegistry.apps || {})];
const knownAppIds = new Set(descriptors.map(([id]) => id));
const knownCapabilities = new Set(descriptors.flatMap(([, descriptor]) => descriptor.capabilities || []));
for (const [method, policy] of Object.entries(methodPolicies)) {
  if (policy.capability && !knownCapabilities.has(policy.capability)) throw new Error(`Method policy ${method} references unknown capability ${policy.capability}.`);
  for (const appId of policy.appIds || []) if (!knownAppIds.has(appId)) throw new Error(`Method policy ${method} references unknown application ${appId}.`);
}

for (const launcher of ['start-provisioner.bat','start-provisioner-debug.bat','start-shell.bat']) {
  const launcherText = await fs.readFile(path.join(root, launcher), 'utf8');
  if (!launcherText.includes('dist\\windows\\bin\\Arcane')) throw new Error(`${launcher} does not target the sealed Windows bin directory.`);
}
for (const launcher of ['start-provisioner-simulation.bat','start-provisioner-simulation.sh','start-shell-simulation.bat','start-shell-simulation.sh']) {
  try {
    await fs.access(path.join(root, launcher));
    throw new Error(`${launcher} must not expose simulation as a product launch mode.`);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}
if (!coreText.includes("const simulate = !process.pkg &&")) throw new Error('Packaged Core must make the internal simulation harness unreachable.');
console.log('Arcane source and generated payload verification passed.');
