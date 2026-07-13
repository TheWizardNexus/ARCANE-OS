import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyMachineContentManifest, writeMachineContentManifest } from './machine-content.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('machine content manifest is deterministic, exact, and excludes only the host/state boundary', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-machine-content-'));
  const bundle = { name: 'Arcane OS Machine Bundle', version: '0.8.2' };
  try {
    await fs.mkdir(path.join(fixture, 'bin'), { recursive: true });
    await fs.mkdir(path.join(fixture, 'app/shell'), { recursive: true });
    await fs.mkdir(path.join(fixture, 'apps'), { recursive: true });
    await fs.writeFile(path.join(fixture, 'bin/ArcaneCore.exe'), 'core');
    await fs.writeFile(path.join(fixture, 'bin/ArcaneOllamaService.exe'), 'ollama service');
    await fs.writeFile(path.join(fixture, 'bin/ArcanePipeGuard.exe'), 'pipe guard');
    await fs.writeFile(path.join(fixture, 'bin/Microsoft.Web.WebView2.Core.dll'), 'core dll');
    await fs.writeFile(path.join(fixture, 'bin/Microsoft.Web.WebView2.WinForms.dll'), 'forms dll');
    await fs.writeFile(path.join(fixture, 'bin/WebView2Loader.dll'), 'loader dll');
    await fs.writeFile(path.join(fixture, 'app/shell/index.html'), 'shell');
    await fs.writeFile(path.join(fixture, 'apps/catalog.json'), '{}');
    await fs.writeFile(path.join(fixture, 'arcane-bundle.json'), '{}');
    await fs.writeFile(path.join(fixture, 'arcane-release.json'), '{}');
    const first = await writeMachineContentManifest({ releaseRoot: fixture, bundle });
    const second = await writeMachineContentManifest({ releaseRoot: fixture, bundle });
    assert.equal(second.sha256, first.sha256);
    await fs.writeFile(path.join(fixture, 'bin/ArcaneProvisioner.exe'), 'excluded host');
    await assert.rejects(
      () => writeMachineContentManifest({ releaseRoot: fixture, bundle }),
      /with either both native hosts present or neither/,
    );
    await fs.writeFile(path.join(fixture, 'bin/ArcaneShell.exe'), 'excluded host');
    const postHost = await writeMachineContentManifest({ releaseRoot: fixture, bundle });
    assert.equal(postHost.sha256, first.sha256, 'excluded native hosts must not change the publisher-bound machine content hash');
    assert.deepEqual(first.manifest.files.map((file) => file.path), [
      'app/shell/index.html',
      'apps/catalog.json',
      'arcane-bundle.json',
      'bin/ArcaneCore.exe',
      'bin/ArcaneOllamaService.exe',
      'bin/ArcanePipeGuard.exe',
      'bin/Microsoft.Web.WebView2.Core.dll',
      'bin/Microsoft.Web.WebView2.WinForms.dll',
      'bin/WebView2Loader.dll',
    ]);
    await verifyMachineContentManifest({ releaseRoot: fixture, version: bundle.version });
    await fs.writeFile(path.join(fixture, 'unlisted.txt'), 'tamper');
    await assert.rejects(
      () => verifyMachineContentManifest({ releaseRoot: fixture, version: bundle.version }),
      /release root must contain exactly/,
    );
    await fs.rm(path.join(fixture, 'unlisted.txt'));

    await fs.writeFile(path.join(fixture, 'bin/debug.dll'), 'unexpected bin entry');
    await assert.rejects(
      () => verifyMachineContentManifest({ releaseRoot: fixture, version: bundle.version }),
      /verified bin must contain exactly/,
    );
    await fs.rm(path.join(fixture, 'bin/debug.dll'));

    await fs.mkdir(path.join(fixture, 'app/empty'));
    await assert.rejects(
      () => verifyMachineContentManifest({ releaseRoot: fixture, version: bundle.version }),
      /release contains empty directory "app\/empty"/,
    );
    await fs.rm(path.join(fixture, 'app/empty'), { recursive: true });

    await fs.writeFile(path.join(fixture, 'arcane-install.json'), '{}');
    await assert.rejects(
      () => writeMachineContentManifest({ releaseRoot: fixture, bundle }),
      /release root must contain exactly/,
    );
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('native host parses the bound manifest from the same retained deny-write handle', async () => {
  const source = await fs.readFile(path.join(root, 'src/hosts/windows/ArcaneHost.cs'), 'utf8');
  const retain = source.indexOf('FileStream retainedManifest = RetainFile(manifestPath, retainedByPath, retained);');
  const retainDirectories = source.indexOf('RetainDirectoryTree(root, root, retainedDirectoriesByPath, retainedDirectories);');
  const hash = source.indexOf('string manifestHash = HashStream(retainedManifest);');
  const read = source.indexOf('byte[] manifestBytes = ReadRetainedFile(retainedManifest');
  const parse = source.indexOf('Dictionary<string, object> manifest = ParseObject(manifestBytes, manifestName);');
  assert(retainDirectories >= 0 && retainDirectories < retain && retain < hash && hash < read && read < parse);
  assert.match(source, /FileMode\.Open, FileAccess\.Read, FileShare\.Read/);
  assert.match(source, /FileFlagBackupSemantics \| FileFlagOpenReparsePoint/);
  assert.match(source, /FileReadAttributes \| FileListDirectory/);
  assert.match(source, /GetFileInformationByHandle/);
  assert.match(source, /GetFinalPathNameByHandle/);
  assert.match(source, /VerifyRetainedDirectoryIdentities\(retainedDirectories\)/);
  assert.match(source, /VerifyMachineContentLayout\(files\)/);
  assert.match(source, /VerifyTargetContentLayout\(files\)/);
  assert.match(source, /if \(entries\.Length == 0\) throw new InvalidDataException\("Arcane releases cannot contain empty directories/);
  assert.match(source, /return new ReleaseSecurityResult\([\s\S]+?security\.PublisherTrustSource,[\s\S]+?retainedDirectories\);/);
  assert.doesNotMatch(source, /FileShareDelete/);
  assert.doesNotMatch(source, /File\.ReadAllBytes\(manifestPath\)/);
  assert.match(source, /RetainAndRecheck\(root, files, excludedHosts, retainedByPath, retained\)/);
  assert.match(source, /if \(releaseSecurity != null\) releaseSecurity\.Dispose\(\)/);
  assert.match(source, /ARCANE_RELEASE_SECURITY_MODE/);
  assert.match(source, /WinVerifyTrust/);
  assert.match(source, /if \(count != 1\).*exactly one matching release content binding/);
});

test('Windows directory handles deny namespace rebinding and expose reparse identity', { skip: process.platform !== 'win32' }, () => {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const script = path.join(root, 'tools/smoke-test-windows-release-directory-locks.ps1');
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout || ''}\n${result.stderr || ''}`);
  assert.match(result.stdout, /blocked root\/subdirectory rename and exposed junction reparse identity/);
});

test('Windows builders bind only finalized content and require timestamps for every signed build', async () => {
  const [target, host, release, verifier, finalizer] = await Promise.all([
    fs.readFile(path.join(root, 'tools/build-windows-target-app.ps1'), 'utf8'),
    fs.readFile(path.join(root, 'tools/build-windows-webview2.ps1'), 'utf8'),
    fs.readFile(path.join(root, 'tools/build-windows-release.ps1'), 'utf8'),
    fs.readFile(path.join(root, 'tools/verify-windows-release-security.ps1'), 'utf8'),
    fs.readFile(path.join(root, 'tools/finalize-app-package.mjs'), 'utf8'),
  ]);
  assert(target.indexOf("Sign-ArcaneFile 'ArcaneCore.exe'") < target.indexOf('write-app-content-manifest.mjs'));
  assert(target.indexOf('write-app-content-manifest.mjs') < target.indexOf('AssemblyMetadata("ArcaneContentBinding"'));
  assert(target.indexOf('AssemblyMetadata("ArcaneContentBinding"') < target.indexOf('Sign-ArcaneFile $launcherExe'));
  assert.doesNotMatch(target, /\$launcherBatch/);
  assert.doesNotMatch(target, /WriteAllText\(\(Join-Path \$stage "start-\$AppId\.bat"/);
  assert.match(target, /ARCANE_TIMESTAMP_SERVER is required whenever an Arcane signing certificate is configured/);
  assert.match(host, /ARCANE_TIMESTAMP_SERVER is required whenever an Arcane signing certificate is configured/);
  assert.match(verifier, /Every signed Arcane executable must have an Authenticode timestamp/);
  assert.match(verifier, /verify-content-bindings\.mjs'\) target \$appRoot \$appId \$expectedTargetHash/);
  assert.match(verifier, /contentManifestSha256/);
  assert.match(finalizer, /verifyAppContentManifest/);
  assert.doesNotMatch(finalizer, /writeAppContentManifest/);
  assert(release.indexOf('build-app.mjs') < release.indexOf("Copy-Item -LiteralPath $generatedApps"));
  assert(release.indexOf('write-release-manifest.mjs') < release.lastIndexOf('Publish-VerifiedArcaneDirectory -Stage'));
});

test('Windows production and local-test release flavors are explicit and fail closed', async () => {
  const [packageJsonText, release, target, appBuilder] = await Promise.all([
    fs.readFile(path.join(root, 'package.json'), 'utf8'),
    fs.readFile(path.join(root, 'tools/build-windows-release.ps1'), 'utf8'),
    fs.readFile(path.join(root, 'tools/build-windows-target-app.ps1'), 'utf8'),
    fs.readFile(path.join(root, 'tools/build-app.mjs'), 'utf8'),
  ]);
  const scripts = JSON.parse(packageJsonText).scripts;
  assert.equal(scripts['build:win'], 'npm run build:distribution:windows');
  assert.doesNotMatch(scripts['build:distribution:windows'], /AllowUnsignedLocalRelease/);
  assert.match(scripts['build:distribution:windows:unsigned-local-test'], /-AllowUnsignedLocalRelease$/);
  assert.match(scripts['verify:winsecurity'], /-RequireSigned/);
  assert.doesNotMatch(scripts['verify:winsecurity:unsigned-local-test'], /-RequireSigned/);
  assert.match(release, /param\([\s\S]*\[switch\]\$AllowUnsignedLocalRelease/);
  assert.match(release, /Production Windows distribution requires ARCANE_SIGNING_CERT_THUMBPRINT/);
  assert.match(release, /Production Windows distribution requires ARCANE_TIMESTAMP_SERVER/);
  assert.match(release, /Production Windows distribution requires ARCANE_EXPECTED_PUBLISHER_THUMBPRINT/);
  assert.match(release, /ARCANE_SIGNING_CERT_THUMBPRINT must match the independent ARCANE_EXPECTED_PUBLISHER_THUMBPRINT/);
  assert.match(release, /AllowUnsignedLocalRelease conflicts with ARCANE_REQUIRE_SIGNED_RELEASE=1/);
  assert.match(release, /Production Windows distribution conflicts with ARCANE_REQUIRE_SIGNED_RELEASE=0/);
  assert.match(release, /SetEnvironmentVariable\('ARCANE_REQUIRE_SIGNED_RELEASE', \$requiredSigningPolicy, 'Process'\)/);
  assert.match(release, /SetEnvironmentVariable\('ARCANE_REQUIRE_SIGNED_RELEASE', \$previousSigningPolicy, 'Process'\)/);
  assert.match(release, /UNSIGNED LOCAL-TEST ALLOWED/);
  assert.match(release, /PRODUCTION SIGNED/);
  assert.match(target, /if \(-not \$signingPolicy\) \{ \$requireSignedRelease = \$true \}/);
  assert.match(target, /PRODUCTION SIGNED/);
  assert.match(appBuilder, /args\.includes\('--allow-unsigned-local-release'\)/);
  assert.match(appBuilder, /ARCANE_REQUIRE_SIGNED_RELEASE: '0'/);
  assert.match(appBuilder, /conflicts with ARCANE_REQUIRE_SIGNED_RELEASE=1/);
  assert.match(release, /\$appBuildArguments \+= '--allow-unsigned-local-release'/);
});

test('Windows publication state is stable, locked, recovered, and verified before backup removal', async () => {
  const [release, target] = await Promise.all([
    fs.readFile(path.join(root, 'tools/build-windows-release.ps1'), 'utf8'),
    fs.readFile(path.join(root, 'tools/build-windows-target-app.ps1'), 'utf8'),
  ]);
  for (const source of [release, target]) {
    assert.match(source, /function Recover-ArcanePublication/);
    assert.match(source, /function Publish-VerifiedArcaneDirectory/);
    assert.match(source, /\[IO\.FileShare\]::None/);
    assert.doesNotMatch(source, /\[bool\]\$RequireSigned\s*=\s*\$false/);
    assert.match(source, /\$targetVerified = \$true[\s\S]*if \(\$targetVerified\)/);
    assert.match(source, /throw \$publicationFailure[\s\S]*if \(Test-Path -LiteralPath \$Backup\)/);
    assert.match(source, /-not \(Test-Path -LiteralPath \$Target\)[\s\S]*Test-Path -LiteralPath \$Backup[\s\S]*Move-Item -LiteralPath \$Backup -Destination \$Target/);
    assert.match(source, /finally \{[\s\S]*Test-Path -LiteralPath \$Stage[\s\S]*Remove-Item -LiteralPath \$Stage/);
  }
  assert.match(release, /Join-Path \$distRoot '\.windows\.stage'/);
  assert.match(release, /Join-Path \$distRoot '\.windows\.backup'/);
  assert.match(release, /function Assert-ReproducibleUnsignedDistribution/);
  assert.match(release, /Only a complete unsigned reproducible build output may bypass native rollback migration/);
  assert.match(release, /-ReplaceReproducibleTarget \$replaceReproducibleDistribution/);
  assert.doesNotMatch(release, /\.windows\.(?:stage|backup)-\$PID/);
  assert.match(target, /Join-Path \$targetsRoot "\.\$AppId\.native-stage"/);
  assert.match(target, /Join-Path \$targetsRoot "\.\$AppId\.native-backup"/);
  assert.doesNotMatch(target, /native-(?:stage|backup)-\$PID/);
  assert.match(target, /function Assert-ReproduciblePortableTarget/);
  assert.match(target, /function Assert-ReproducibleUnsignedNativeTarget/);
  assert.match(target, /ExpectedPublisherThumbprint ''/);
  assert.match(target, /Only the exact portable Arcane package shape may be replaced/);
  assert.match(target, /Portable Arcane package identity or version mismatch/);
  assert.match(target, /runtime\\arcane-core\.cjs/);
  assert.match(target, /Portable Arcane package contains native release material/);
  assert.match(target, /Get-FileHash -Algorithm SHA256/);
  assert.match(target, /-ReplaceReproducibleTarget \$replaceReproducibleTarget/);
});
