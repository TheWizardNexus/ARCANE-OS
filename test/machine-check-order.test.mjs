import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = 'machine_bundles/arcane-os-machine-bundle-v0.8.2';
const bundleRoot = path.join(repositoryRoot, ...bundlePath.split('/'));

function commandPositions(command, expected) {
  const operations = command.split(/\s*&&\s*/);
  return Object.fromEntries(expected.map((operation) => [operation, operations.indexOf(operation)]));
}

test('the mandatory machine checks build portable apps and one unified Windows distribution', async () => {
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
  assert.equal(
    scripts['build:apps:windows:unsigned-local-test'],
    'node tools/build-app.mjs --all --platform=windows --allow-unsigned-local-release',
  );
  assert.equal(scripts['build:app:windows'], 'node tools/build-app.mjs --platform=windows');
  assert.equal(
    scripts['build:app:windows:unsigned-local-test'],
    'node tools/build-app.mjs --platform=windows --allow-unsigned-local-release',
  );
  assert.doesNotMatch(scripts['build:apps:windows'], /allow-unsigned/i);
  assert.doesNotMatch(scripts['build:app:windows'], /allow-unsigned/i);
  assert.match(scripts.check || '', /(?:^|&&\s*)npm run build:apps:portable(?:\s*&&|$)/);
  assert.doesNotMatch(
    scripts.check || '',
    /(?:^|&&\s*)npm run build:apps(?:\s*&&|$)/,
    'the mandatory check must not choose native packaging from the host operating system',
  );
  assert.equal(scripts['build:win'], 'npm run build:distribution:windows');
  assert.match(scripts['build:distribution:windows'] || '', /powershell .+tools\/build-windows-release\.ps1$/);
  assert.doesNotMatch(scripts['build:distribution:windows'] || '', /AllowUnsignedLocalRelease/);
  assert.match(
    scripts['build:distribution:windows:unsigned-local-test'] || '',
    /tools\/build-windows-release\.ps1 -AllowUnsignedLocalRelease$/,
  );
  assert.equal(
    scripts['verify:windispatch'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File tools/verify-windows-host-dispatch.ps1 -Dist dist/windows/bin',
  );
  assert.match(scripts['test:content-binding'] || '', /content-binding\.test\.mjs/);
  assert.match(scripts['test:content-binding'] || '', /windows-publication-recovery\.test\.mjs/);
  assert.match(scripts['smoke:windows:release-directory-locks'] || '', /smoke-test-windows-release-directory-locks\.ps1/);
  assert.match(scripts['smoke:windows:installed-apps'] || '', /smoke-test-windows-installed-apps\.mjs/);
  assert.match(scripts['verify:distribution:windows'] || '', /verify-built-release\.mjs dist\/windows/);
  assert.match(scripts['verify:distribution:windows'] || '', /npm run verify:winsecurity/);
  assert.match(scripts['verify:distribution:windows:unsigned-local-test'] || '', /npm run verify:winsecurity:unsigned-local-test/);
  assert.match(scripts['verify:winsecurity'] || '', /verify-windows-release-security\.ps1/);
  assert.match(scripts['verify:winsecurity'] || '', /-RequireSigned/);
  assert.doesNotMatch(scripts['verify:winsecurity:unsigned-local-test'] || '', /-RequireSigned/);

  const windowsCheck = scripts['check:windows'] || '';
  const required = [
    'npm run test:content-binding',
    'npm run smoke:windows:release-directory-locks',
    'npm run smoke:windows:installed-apps',
    'npm run build:distribution:windows:unsigned-local-test',
    'npm run verify:apps',
    'npm run verify:app-catalog',
    'npm run verify:distribution:windows:unsigned-local-test',
    'npm run verify:windispatch',
  ];
  const positions = commandPositions(windowsCheck, required);
  for (const operation of required) assert.notEqual(positions[operation], -1, `check:windows is missing ${operation}`);
  assert.equal(
    windowsCheck.split('npm run build:distribution:windows:unsigned-local-test').length - 1,
    1,
    'check:windows must build the unified Windows distribution exactly once',
  );
  assert.doesNotMatch(
    windowsCheck,
    /(?:^|&&\s*)npm run build:distribution:windows(?:\s*&&|$)/,
    'mandatory unsigned CI verification must use the unmistakable local-test build command',
  );
  assert.doesNotMatch(windowsCheck, /npm run build:apps:windows/, 'the sealed distribution must not be desynchronized by a second app build');
  assert(positions['npm run test:content-binding'] < positions['npm run build:distribution:windows:unsigned-local-test']);
  assert(positions['npm run smoke:windows:release-directory-locks'] < positions['npm run build:distribution:windows:unsigned-local-test']);
  assert(positions['npm run smoke:windows:installed-apps'] < positions['npm run build:distribution:windows:unsigned-local-test']);
  for (const verification of required.slice(4)) {
    assert(positions['npm run build:distribution:windows:unsigned-local-test'] < positions[verification], `${verification} must inspect the published distribution`);
  }
});

test('Windows CI runs the portable gate before the unified Windows distribution gate', async () => {
  const workflow = await fs.readFile(path.join(repositoryRoot, '.github/workflows/arcane-check.yml'), 'utf8');
  const portableCheck = workflow.indexOf('run: npm run check');
  const windowsCheck = workflow.indexOf(`run: npm run check:windows --prefix ${bundlePath}`);

  for (const [label, position] of Object.entries({ portableCheck, windowsCheck })) {
    assert.notEqual(position, -1, `workflow is missing ${label}`);
  }
  assert(portableCheck < windowsCheck, 'portable checks must finish before Windows release work');
  assert.doesNotMatch(workflow, /run: npm run build:apps:windows/, 'CI must not rebuild apps after sealing the Windows distribution');
  assert.doesNotMatch(workflow, /run: npm run build:win --prefix/, 'CI must enter Windows release work through check:windows');
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
