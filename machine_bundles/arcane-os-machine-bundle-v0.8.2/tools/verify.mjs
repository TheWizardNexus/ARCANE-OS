import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
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
console.log('Arcane source and generated payload verification passed.');
