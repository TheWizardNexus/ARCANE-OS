import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTargetApp, listTargetApps } from './app-packager-lib.mjs';
import { publishWindowsAppProjection } from './app-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.resolve(here, '..');
const args = process.argv.slice(2);
const allowUnsignedLocalRelease = args.includes('--allow-unsigned-local-release');

function option(name) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const platform = option('--platform') || (process.platform === 'win32' ? 'windows' : 'portable');
if (!['portable', 'windows'].includes(platform)) throw new Error('Supported app package platforms are portable and windows.');
if (allowUnsignedLocalRelease && platform !== 'windows') throw new Error('Unsigned local-release permission applies only to Windows native app wrapping.');
if (allowUnsignedLocalRelease && process.env.ARCANE_REQUIRE_SIGNED_RELEASE === '1') {
  throw new Error('--allow-unsigned-local-release conflicts with ARCANE_REQUIRE_SIGNED_RELEASE=1.');
}

async function buildApp(appId) {
  if (platform === 'portable') return buildTargetApp({ bundleRoot, appId });
  if (process.platform !== 'win32') throw new Error('Windows native app wrapping must run on Windows.');
  const temporaryOutput = path.join(bundleRoot, 'dist', 'targets', `.windows-source-${appId}-${process.pid}`);
  try {
    const source = await buildTargetApp({ bundleRoot, appId, outputRoot: temporaryOutput });
    const target = path.join(bundleRoot, 'dist', 'targets', appId);
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const result = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(bundleRoot, 'tools', 'build-windows-target-app.ps1'),
      '-AppId', appId,
      '-Source', source.target,
      '-Target', target,
    ], {
      cwd: bundleRoot,
      stdio: 'inherit',
      windowsHide: true,
      env: allowUnsignedLocalRelease
        ? { ...process.env, ARCANE_REQUIRE_SIGNED_RELEASE: '0' }
        : process.env,
    });
    if (result.status !== 0) throw new Error(`Windows Arcane app wrapping failed with exit code ${result.status}.`);
    return { ...source, target, platform: 'windows' };
  } finally {
    await fs.rm(temporaryOutput, { recursive: true, force: true });
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node tools/build-app.mjs --app=<registered-name> [--platform=windows|portable] [--allow-unsigned-local-release]\n       node tools/build-app.mjs --all [--platform=windows|portable] [--allow-unsigned-local-release]\n       node tools/build-app.mjs --list');
  process.exit(0);
}

if (args.includes('--list')) {
  const apps = await listTargetApps(bundleRoot);
  for (const app of apps) console.log(`${app.id}\t${app.displayName}\t${app.entry}`);
  process.exit(0);
}

if (args.includes('--all')) {
  const allowed = new Set(['--all', '--platform', platform, `--platform=${platform}`, '--allow-unsigned-local-release']);
  for (const argument of args) if (!allowed.has(argument)) throw new Error(`Unknown argument “${argument}”.`);
  const apps = await listTargetApps(bundleRoot);
  for (const app of apps) {
    const result = await buildApp(app.id);
    console.log(`Built isolated Arcane ${platform} app package for ${result.app} at ${path.relative(bundleRoot, result.target)}.`);
  }
  if (platform === 'windows') {
    const projection = await publishWindowsAppProjection({ bundleRoot, appIds: apps.map((app) => app.id) });
    console.log(`Published ${projection.catalog.apps.length} verified Arcane apps at ${path.relative(bundleRoot, projection.target)}.`);
  }
  process.exit(0);
}

const appId = option('--app');
if (!appId) throw new Error('Pass --app=<registered-name>. Use --list to see valid targets.');
const allowedArguments = new Set([`--app=${appId}`, '--app', appId, '--platform', platform, `--platform=${platform}`, '--allow-unsigned-local-release']);
for (const argument of args) {
  if (!allowedArguments.has(argument)) throw new Error(`Unknown argument “${argument}”.`);
}

const result = await buildApp(appId);
console.log(`Built isolated Arcane ${platform} app package for ${result.app} at ${path.relative(bundleRoot, result.target)}.`);
if (platform === 'windows') {
  const projection = await publishWindowsAppProjection({ bundleRoot, appIds: [appId], preserveExistingApps: true });
  console.log(`Published verified Arcane app runtime projection at ${path.relative(bundleRoot, projection.target)}.`);
}
