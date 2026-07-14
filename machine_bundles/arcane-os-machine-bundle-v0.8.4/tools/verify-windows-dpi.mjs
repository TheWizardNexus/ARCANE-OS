import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredManifestTokens = [
  '<requestedExecutionLevel level="asInvoker" uiAccess="false" />',
  '<dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>',
  '<dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2,PerMonitor</dpiAwareness>',
  '<supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />',
];

export async function verifyWindowsDpiExecutable(executable) {
  const data = await fs.readFile(executable);
  const views = [data.toString('utf8'), data.toString('utf16le')];
  for (const token of ['true/pm', 'PerMonitorV2,PerMonitor']) {
    if (!views.some((view) => view.includes(token))) {
      throw new Error(`${executable} does not embed the Arcane per-monitor DPI manifest token ${token}.`);
    }
  }
}

const manifest = await fs.readFile(path.join(root, 'src', 'hosts', 'windows', 'ArcaneHost.manifest'), 'utf8');
for (const token of requiredManifestTokens) {
  if (!manifest.includes(token)) throw new Error(`ArcaneHost.manifest is missing ${token}.`);
}

const [hostSource, machineBuild, targetBuild] = await Promise.all([
  fs.readFile(path.join(root, 'src', 'hosts', 'windows', 'ArcaneHost.cs'), 'utf8'),
  fs.readFile(path.join(root, 'tools', 'build-windows-webview2.ps1'), 'utf8'),
  fs.readFile(path.join(root, 'tools', 'build-windows-target-app.ps1'), 'utf8'),
]);
if (!hostSource.includes('AutoScaleMode = AutoScaleMode.Dpi;')) {
  throw new Error('ArcaneForm must scale its WinForms host chrome using the active monitor DPI.');
}
for (const [label, script] of [['machine host build', machineBuild], ['target app build', targetBuild]]) {
  if (!script.includes('src\\hosts\\windows\\ArcaneHost.manifest') || !script.includes('/win32manifest:$hostManifest')) {
    throw new Error(`The ${label} does not embed ArcaneHost.manifest.`);
  }
}

const invokedDirectly = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  for (const executable of process.argv.slice(2)) await verifyWindowsDpiExecutable(path.resolve(executable));
  console.log(`Arcane Windows per-monitor DPI contract verified${process.argv.length > 2 ? ` for ${process.argv.length - 2} executable(s)` : ''}.`);
}
