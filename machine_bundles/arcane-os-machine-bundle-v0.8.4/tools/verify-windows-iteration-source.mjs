import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(root, '..', '..');
const [script, packageManifest, buildLauncher, gitAttributes] = await Promise.all([
  fs.readFile(path.join(root, 'tools', 'build-windows-iteration.ps1'), 'utf8'),
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'build-windows.bat'), 'utf8'),
  fs.readFile(path.join(repositoryRoot, '.gitattributes'), 'utf8'),
]);

for (const contract of [
  "$target = Join-Path $distRoot 'nt-iteration'",
  '$stage = Join-Path $distRoot ".nt-iteration.stage-$PID"',
  "$backup = Join-Path $distRoot '.nt-iteration.backup'",
  "$lockPath = Join-Path $distRoot '.windows-iteration.lock'",
  'unresolved legacy Microsoft NT iteration publication state',
  'Assert-IterationPath $candidate',
  "[Environment]::SetEnvironmentVariable('ARCANE_REQUIRE_SIGNED_RELEASE', '0', 'Process')",
  "tools\\build-core.mjs",
  "tools\\verify.mjs",
  "tools\\verify-app-packages.mjs",
  "tools\\verify-app-catalog.mjs",
  "Copy-Item -LiteralPath $generatedApps",
  "'node22-win-x64'",
  "tools\\build-windows-webview2.ps1",
  "tools\\write-release-manifest.mjs",
  'Assert-IterationRelease $stage',
  'Assert-IterationRelease $target',
  'Close the running iteration Provisioner/Shell before rebuilding',
  '--allow-unsigned-local-release',
]) {
  assert.match(script, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `Microsoft NT iteration build contract is missing: ${contract}`);
}

assert.doesNotMatch(script, /build-app[.]mjs|build-windows-target-app[.]ps1|['"]--all['"]|\s--all(?:\s|$)/m,
  'The fast Microsoft NT iteration path must not rebuild target applications.');
assert.doesNotMatch(script, /Join-Path \$distRoot 'nt'(?!-iteration)/,
  'The fast Microsoft NT iteration path must not publish over the canonical Microsoft NT distribution.');

assert.equal(
  packageManifest.scripts['build:windows:iteration'],
  'npm run verify:winhost && powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/build-windows-iteration.ps1',
);
assert.match(packageManifest.scripts['build:distribution:windows'], /build-windows-release[.]ps1/,
  'Production Microsoft NT builds must continue to use the complete release builder.');
assert.match(packageManifest.scripts['check:windows'], /build:distribution:windows:unsigned-local-test/,
  'The Microsoft NT check gate must continue to build every target application through the full release path.');
assert.equal(packageManifest.scripts.prepush, 'npm run check && npm run check:windows',
  'The complete pre-push gate must remain unchanged.');

assert.equal(
  buildLauncher.match(/if not "%errorlevel%"=="0" goto :failed/g)?.length,
  2,
  'The Microsoft NT launcher must stop after every nonzero npm exit code, including negative Microsoft NT status codes.',
);
assert.match(
  gitAttributes,
  /^machine_bundles\/[*]\/arcane-bundle[.]json text eol=lf$/m,
  'Canonical manifests for every machine bundle version must remain LF-only on Microsoft NT checkouts.',
);

console.log('Fast Microsoft NT iteration build remains isolated from full release and target-app publication.');
