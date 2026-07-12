import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourcePath = path.join(root, 'src/hosts/windows/ArcaneHost.cs');
const source = await fs.readFile(sourcePath, 'utf8');
const frontendPath = path.join(root, 'src/frontend/shared/arcane-api.js');
const frontend = await fs.readFile(frontendPath, 'utf8');

if (!source.includes('public sealed class ArcaneBridge')) {
  throw new Error('ArcaneBridge must remain public so WebView2 can project it into JavaScript.');
}
if (!source.includes('internal ArcaneBridge(ArcaneCoreProcess coreProcess)')) {
  throw new Error('ArcaneBridge constructor must be internal because ArcaneCoreProcess is an internal host implementation type.');
}
if (source.includes('public ArcaneBridge(ArcaneCoreProcess coreProcess)')) {
  throw new Error('Windows host would fail with CS0051: public ArcaneBridge constructor exposes internal ArcaneCoreProcess.');
}
if (!source.includes('internal sealed class ArcaneCoreProcess')) {
  throw new Error('ArcaneCoreProcess should remain internal to the native Windows host.');
}
if (!source.includes('public string Send(string requestJson)')) {
  throw new Error('ArcaneBridge must expose Send so WebView2 can resolve it through COM IDispatch.');
}
if (source.includes('public string Invoke(string requestJson)')) {
  throw new Error('ArcaneBridge.Invoke conflicts with COM IDispatch.Invoke and is not script-callable. Use Send.');
}
if (!frontend.includes('this.bridge.Send(JSON.stringify(request))')) {
  throw new Error('The WebView2 frontend transport must call ArcaneBridge.Send.');
}
if (frontend.includes('this.bridge.Invoke(JSON.stringify(request))')) {
  throw new Error('The WebView2 frontend still calls the COM-reserved Invoke name.');
}
if (source.includes('DownloadFileTaskAsync') || source.includes('Verb = "runas"')) {
  throw new Error('The renderer host must not download and elevate an installer before its native trust policy is available.');
}
if (!source.includes('Environment.GetFolderPath(Environment.SpecialFolder.Windows)') || !source.includes('Path.Combine(windows, "explorer.exe")')) {
  throw new Error('The shell emergency desktop must resolve Explorer from the trusted absolute Windows directory.');
}
if (!source.includes('if (Program.AppMode == "shell") EmergencyDesktop.TryStart();')) {
  throw new Error('Shell fatal startup paths must activate the emergency Windows desktop.');
}
if (!source.includes('eventArgs.CloseReason != CloseReason.WindowsShutDown')) {
  throw new Error('The shell emergency desktop must stay disabled during an intentional Windows shutdown or logout.');
}
if (source.includes('Process.Start("explorer.exe")')) {
  throw new Error('The shell fallback must never launch Explorer by a bare executable name.');
}
if (!source.includes('Program.AllowedNavigationPaths') || source.includes('uri.AbsolutePath.StartsWith("/" + Program.AppMode + "/"')) {
  throw new Error('Target hosts must exact-match generated full-document navigation paths and must not allow an app-wide path prefix.');
}

console.log('Windows WebView2 host source and bridge contract preflight passed.');
