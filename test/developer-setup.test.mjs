import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [setup, launcher, verifier, manifest, bundleManifest] = await Promise.all([
  fs.readFile(path.join(root, 'tools', 'setup-developer.ps1'), 'utf8'),
  fs.readFile(path.join(root, 'setup-developer.bat'), 'utf8'),
  fs.readFile(path.join(root, 'tools', 'verify-package-lock-registries.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'machine_bundles', 'arcane-os-machine-bundle-v0.8.4', 'package.json'), 'utf8').then(JSON.parse),
]);

test('developer setup owns one fail-closed Windows bootstrap contract', () => {
  for (const token of [
    'Git.Git',
    'OpenJS.NodeJS.22',
    "'22.23.1'",
    'Microsoft.WindowsSDK.10.0.26100',
    'Preserve-IncompatiblePnpmTree',
    'Remove-UntrackedVendoredDependencyFiles',
    'tmp\\developer-setup-dependency-backups',
    'tmp\\developer-setup-npm-cache',
    'tools\\verify-package-lock-registries.mjs',
    "@('ci', '--no-audit', '--no-fund', '--cache', $npmCache)",
    "@('run', 'hooks:install')",
    "@('run', 'check')",
    "@('run', 'signing:bootstrap:dev:windows')",
    "@('run', 'build:dev:windows')",
    "@('run', 'build:distribution:windows:unsigned-local-test')",
    'if ($exitCode -ne 0)',
  ]) assert.ok(setup.includes(token), `developer setup is missing ${token}`);

  const ordered = [
    'Verifying public package-lock registries',
    'Installing repository dependencies',
    'Installing machine-bundle dependencies',
    'Installing repository Git hooks',
    'Running Arcane repository checks',
    'Initializing local Windows development signing',
    'Building the development-signed Windows distribution',
  ].map((token) => setup.indexOf(token));
  assert.ok(ordered.every((index) => index >= 0));
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
  assert.doesNotMatch(setup, /ARCANE_SIGNING_CERT_THUMBPRINT|build:signed:windows/,
    'developer setup must not read or configure production signing material');
});

test('developer setup is exposed through one root launcher and npm command', () => {
  assert.match(launcher, /tools\\setup-developer[.]ps1/);
  assert.match(launcher, /if not "%ARCANE_SETUP_EXIT%"=="0"/);
  assert.equal(
    manifest.scripts['setup:developer'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File tools/setup-developer.ps1',
  );
});

test('developer setup uses deterministic lockfiles and permits one-time Windows trust confirmation', () => {
  assert.match(verifier, /'package-lock[.]json'/);
  assert.match(verifier, /'machine_bundles[/][*][/]package-lock[.]json'/);
  assert.doesNotMatch(verifier, /'[*]package-lock[.]json'/);
  for (const packageManifest of [manifest, bundleManifest]) {
    const bootstrap = packageManifest.scripts['signing:bootstrap:dev:windows'];
    assert.match(bootstrap, /-BootstrapOnly/);
    assert.doesNotMatch(bootstrap, /-NonInteractive/);
  }
});
