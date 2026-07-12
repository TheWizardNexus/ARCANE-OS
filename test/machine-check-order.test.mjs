import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = 'machine_bundles/arcane-os-machine-bundle-v0.8.2';
const bundleRoot = path.join(repositoryRoot, ...bundlePath.split('/'));

test('the mandatory machine check always builds portable app packages', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(bundleRoot, 'package.json'), 'utf8'));
  const scripts = packageJson.scripts || {};

  assert.equal(
    scripts['build:apps:portable'],
    'node tools/build-app.mjs --all --platform=portable',
    'portable app packaging must select its platform explicitly',
  );
  assert.equal(
    scripts['build:apps:windows'],
    'node tools/build-app.mjs --all --platform=windows',
    'native Windows app packaging must remain an explicit operation',
  );
  assert.match(scripts.check || '', /(?:^|&&\s*)npm run build:apps:portable(?:\s*&&|$)/);
  assert.doesNotMatch(
    scripts.check || '',
    /(?:^|&&\s*)npm run build:apps(?:\s*&&|$)/,
    'the mandatory check must not choose native packaging from the host operating system',
  );
  assert.match(scripts['check:windows'] || '', /(?:^|&&\s*)npm run build:win(?:\s*&&|$)/);
  assert.match(scripts['check:windows'] || '', /(?:^|&&\s*)npm run build:apps:windows(?:\s*&&|$)/);
  assert.match(scripts['check:windows'] || '', /(?:^|&&\s*)npm run verify:apps(?:\s*&&|$)/);
  assert.match(scripts['check:windows'] || '', /(?:^|&&\s*)npm run verify:windispatch(?:\s*&&|$)/);
});

test('Windows CI acquires the pinned WebView2 SDK before native targeted app builds', async () => {
  const workflow = await fs.readFile(path.join(repositoryRoot, '.github/workflows/arcane-check.yml'), 'utf8');
  const portableCheck = workflow.indexOf('run: npm run check');
  const windowsRelease = workflow.indexOf(`run: npm run build:win --prefix ${bundlePath}`);
  const nativeApps = workflow.indexOf(`run: npm run build:apps:windows --prefix ${bundlePath}`);
  const nativeVerification = workflow.indexOf(`run: npm run verify:apps --prefix ${bundlePath}`);
  const dispatchVerification = workflow.indexOf(`run: npm run verify:windispatch --prefix ${bundlePath}`);

  for (const [label, position] of Object.entries({ portableCheck, windowsRelease, nativeApps, nativeVerification, dispatchVerification })) {
    assert.notEqual(position, -1, `workflow is missing ${label}`);
  }
  assert(portableCheck < windowsRelease, 'portable checks must finish before Windows release work');
  assert(windowsRelease < nativeApps, 'the Windows release must acquire and verify WebView2 before native app builds');
  assert(nativeApps < nativeVerification, 'native app packages must be verified after they are built');
  assert(nativeVerification < dispatchVerification, 'compiled dispatch contracts must be checked after native packages');
});

test('pre-push runs portable and compiled Windows gates including the real pipe guard', async () => {
  const rootPackage = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const hook = await fs.readFile(path.join(repositoryRoot, '.githooks/pre-push'), 'utf8');
  const windowsBuild = await fs.readFile(path.join(bundleRoot, 'tools/build-windows-webview2.ps1'), 'utf8');

  assert.equal(rootPackage.scripts['check:windows'], `npm --prefix ${bundlePath} run check:windows`);
  assert.equal(rootPackage.scripts.prepush, 'npm run check && npm run check:windows');
  assert.match(hook, /exec npm run prepush/);
  assert.match(windowsBuild, /smoke-test-windows-pipe-guard\.mjs/);
});
