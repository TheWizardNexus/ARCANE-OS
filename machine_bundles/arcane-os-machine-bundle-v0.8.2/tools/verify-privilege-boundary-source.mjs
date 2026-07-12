import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [guard, core, windows, linux, host, windowsBuild, targetBuild, releaseIntegrity, machineContent, targetFinalizer, windowsSecurity] = await Promise.all([
  fs.readFile(path.join(root, 'src/hosts/windows/ArcanePipeGuard.cs'), 'utf8'),
  fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/native/linux.cjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/hosts/windows/ArcaneHost.cs'), 'utf8'),
  fs.readFile(path.join(root, 'tools/build-windows-webview2.ps1'), 'utf8'),
  fs.readFile(path.join(root, 'tools/build-windows-target-app.ps1'), 'utf8'),
  fs.readFile(path.join(root, 'tools/release-integrity.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'tools/machine-content.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'tools/finalize-app-package.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'tools/verify-windows-release-security.ps1'), 'utf8'),
]);

assert.match(guard, /GetNamedPipeClientProcessId\s*\(/);
assert.match(guard, /GetNamedPipeClientProcessId\(server\.SafePipeHandle, out clientPid\)/);
assert.match(guard, /clientPid != expectedPid/);
assert.match(guard, /OpenProcess\(ProcessQueryLimitedInformation \| Synchronize, false, expectedPid\)/);
assert.match(guard, /WaitForSingleObject\(expectedProcess, 0\) != WaitTimeout/);
assert.match(guard, /CloseHandle\(expectedProcess\)/);
assert.match(guard, /PipeAccessRule\(identity\.User, PipeAccessRights\.FullControl/);
assert.match(guard, /BuiltinAdministratorsSid/);
assert.match(guard, /LocalSystemSid/);
assert.match(guard, /ARCANE_PIPE_GUARD_REJECTED/);
assert.match(guard, /ARCANE_PIPE_GUARD_BOUND/);

assert.match(core, /const kernelGuarded = !simulate && platform === 'win32'/);
assert.match(core, /path\.resolve\(path\.dirname\(process\.execPath\), 'ArcanePipeGuard\.exe'\)/);
assert.match(core, /path\.resolve\(root, 'bin', 'ArcanePipeGuard\.exe'\)/);
assert.match(core, /spawn\(guardExecutable, \[`--pipe-name=\$\{pipeName\}`\]/);
assert.match(core, /Duplex\.from\(\{ readable: guardProcess\.stdout, writable: guardProcess\.stdin \}\)/);
assert.match(core, /kernelVerifiedPid === launchIdentity\.pid/);
assert.match(core, /if \(kernelGuarded\)[\s\S]+?else \{[\s\S]+?server = net\.createServer/);
assert.match(core, /if \(!simulate && platform === 'linux'\)/);
assert.match(core, /PRIVILEGE_PEER_VERIFICATION_UNAVAILABLE/);
assert.match(core, /verifyPrivilegePipeGuardTrust/);
assert.match(core, /verifyUnsignedLocalPipeGuardBinding/);
assert.match(core, /if \(allowUnsignedLocalRelease\) workerArgs\.push\('--allow-unsigned-local-release'\);/);
assert.match(core, /'EXTERNAL_PROVISIONER_REQUIRED'/);
assert.match(core, /payload\.selfHosted/);
const selfHostedCheck = core.indexOf('if (!simulate && payload.selfHosted)');
const missingPayloadCheck = core.indexOf('if (!payload.files || !payload.files.length)');
assert(selfHostedCheck >= 0 && missingPayloadCheck > selfHostedCheck,
  'an installed Provisioner must require an external updater before generic payload errors or file mutation');
assert.match(windows, /Get-AuthenticodeSignature/);
assert.match(windows, /guardThumbprint === coreThumbprint/);
assert.match(windows, /allowUnsignedLocalRelease/);
assert.match(windows, /const forwardUnsignedClaim = Boolean\(ctx\.allowUnsignedLocalRelease\)/);
assert.match(windows, /relaunchArgs\.includes\('--allow-unsigned-local-release'\)/);
assert.match(windows, /\$env:ARCANE_RELEASE_SECURITY_MODE='unsigned-local-test'/);
assert.match(windows, /Remove-Item -LiteralPath 'Env:ARCANE_RELEASE_SECURITY_MODE'/);
assert.match(windows, /runningInstalledArcaneProcesses/);
assert.match(windows, /relativePath: normalizeInstalledPath\(record\.relativePath/);
assert.match(windows, /function hostReleaseSecurityMode\(\)/);
assert.match(windows, /function legacyInstallLeasePath\(\)/);
assert.match(windows, /writeFile\(legacyTarget, canonicalJson\(lease, true\), \{ encoding: 'utf8', flag: 'wx'/);
assert.match(windows, /legacyRecoveryRequired: true/);
assert.match(windows, /releaseOwnedInstallLeaseFile\(target, lease\)\.catch/);
assert.match(host, /bool allowUnsigned = HasExactArgument\(args, "--allow-unsigned-local-release"\);/);
assert.match(host, /string securityMode = VerifyExecutableSignatures\(executables, allowUnsigned, publisherMarker\);/);
assert.match(host, /internal bool IsUnsignedLocalTest \{ get \{ return String\.Equals\(SecurityMode, "unsigned-local-test", StringComparison\.Ordinal\); \} \}/);
assert.match(host, /start\.EnvironmentVariables\["ARCANE_RELEASE_SECURITY_MODE"\] = releaseSecurity\.SecurityMode;/);
assert.match(host, /private const string PublisherMetadataKey = "ArcanePublisherBinding";/);
assert.match(host, /private static readonly string UnsignedPublisherMarker = String\.Concat\(PublisherMarkerPrefix, "UNSIGNED-", "LOCAL-", "TEST"\);/);
assert.doesNotMatch(host, /"ARCANE-PUBLISHER\|1\|UNSIGNED-LOCAL-TEST"/);
assert.match(host, /not signed by its configured publisher certificate/);
const buildArguments = host.match(/private static string BuildArguments\([\s\S]+?(?=\n\s*private static string Quote\()/)?.[0] || '';
assert.match(buildArguments, /if \(releaseSecurity\.IsUnsignedLocalTest\) result\.Append\(" --allow-unsigned-local-release"\);/);
assert.doesNotMatch(buildArguments, /arg == "--allow-unsigned-local-release"/);

assert.match(host, /private const string MachineManifestName = "arcane-machine-content\.json";/);
assert.match(host, /string expectedPrefix = "ARCANE-MACHINE-BINDING\|1\|";/);
assert.match(host, /if \(!FixedTimeEquals\(markerParts\[3\], manifestHash\)\) throw new InvalidDataException/);
assert.match(host, /RequireInventoryFile\(files, "apps\/catalog\.json"\);/);
assert.match(host, /RequireEmbeddedMarker\(retainedByPath\[Path\.GetFullPath\(otherHostPath\)\], marker\);/);
assert.match(host, /RequireEmbeddedMarker\(retainedByPath\[Path\.GetFullPath\(otherHostPath\)\], publisherMarker\);/);

assert.match(core, /\^\[A-Za-z0-9_-\]\{22\}\$/);
assert.match(core, /authTag\.length !== 16/);
assert.match(core, /authTag\.toString\('base64url'\) !== authTagText/);
assert.match(core, /createCipheriv\('aes-256-gcm',[^\n]+\{ authTagLength: 16 \}\)/);
assert.match(core, /createDecipheriv\('aes-256-gcm',[^\n]+\{ authTagLength: 16 \}\)/);
assert.doesNotMatch(core, /setAuthTag\(Buffer\.from\(String\(envelope\.authTag/);

assert.match(linux, /canElevate: Boolean\(ctx\.simulate\)/);
assert.match(linux, /SO_PEERCRED guard unavailable/);
assert.match(linux, /async function launchElevated[\s\S]+?if \(ctx\.simulate\)[\s\S]+?throw ctx\.arcaneError\([\s\S]+?'PRIVILEGE_PEER_VERIFICATION_UNAVAILABLE'/);
assert.doesNotMatch(linux, /commandExists\('pkexec'\)/);
assert.doesNotMatch(linux, /commandExists\('sudo'\)/);

for (const build of [windowsBuild, targetBuild]) {
  assert.match(build, /ArcanePipeGuard\.cs/);
  assert.match(build, /ArcanePipeGuard\.exe/);
  assert.match(build, /smoke-test-windows-pipe-guard\.mjs/);
  assert.match(build, /Set-AuthenticodeSignature/);
  assert.match(build, /\$requireSignedRelease\s*=\s*\$env:ARCANE_REQUIRE_SIGNED_RELEASE -eq '1'/);
  assert.match(build, /if \(\$signingThumbprint\) \{\s*if \(-not \$timestampServer\)/);
  assert.match(build, /elseif \(\$requireSignedRelease\)/);
  assert.match(build, /TimeStamperCertificate/);
  assert.match(build, /ARCANE_EXPECTED_PUBLISHER_THUMBPRINT/);
  assert.match(build, /signing certificate does not match ARCANE_EXPECTED_PUBLISHER_THUMBPRINT/);
  assert.match(build, /ARCANE-PUBLISHER\|1\|UNSIGNED-LOCAL-TEST/);
  assert.match(build, /AssemblyMetadata\("ArcanePublisherBinding", "\$publisherBinding"\)/);
}
assert.match(windowsBuild, /\$bin = Join-Path \$release 'bin'/);
assert.match(windowsBuild, /machine-content\.mjs'\) write \$release/);
assert.match(windowsBuild, /\$machineBinding = "ARCANE-MACHINE-BINDING\|1\|\$\(\$bundle\.version\)\|\$contentHash"/);
assert.match(windowsBuild, /AssemblyMetadata\("ArcaneContentBinding", "\$machineBinding"\)/);
const machineWriteIndex = windowsBuild.indexOf("machine-content.mjs') write $release");
const machineBindingIndex = windowsBuild.indexOf('$machineBinding = "ARCANE-MACHINE-BINDING|1|');
const firstHostBuildIndex = windowsBuild.indexOf("Build-Host 'ArcaneProvisioner.exe'");
assert(machineWriteIndex >= 0 && machineBindingIndex > machineWriteIndex && firstHostBuildIndex > machineBindingIndex,
  'Windows hosts must be compiled only after the exact machine content manifest is written and hashed.');

assert.match(releaseIntegrity, /'bin\/ArcanePipeGuard\.exe'/);
assert.match(releaseIntegrity, /'arcane-machine-content\.json'/);
assert.match(releaseIntegrity, /'apps\/catalog\.json'/);
assert.match(machineContent, /'bin\/ArcaneProvisioner\.exe'/);
assert.match(machineContent, /'bin\/ArcaneShell\.exe'/);
assert.match(machineContent, /enumerateMachineContent\(root, \{ phase: 'write' \}\)/);
assert.match(machineContent, /enumerateMachineContent\(root, \{ phase: 'verify' \}\)/);
assert.match(machineContent, /manifest does not exactly match the release payload/);
assert.match(targetFinalizer, /pipeGuard: 'ArcanePipeGuard\.exe'/);
assert.match(windowsSecurity, /ARCANE_EXPECTED_PUBLISHER_THUMBPRINT/);
assert.match(windowsSecurity, /actualPublisherThumbprint -cne \$normalizedExpectedPublisherThumbprint/);
assert.match(windowsSecurity, /expectedPublisherMarker = 'ARCANE-PUBLISHER\|1\|' \+ \$normalizedExpectedPublisherThumbprint/);
assert.match(windowsSecurity, /Get-ArcaneMarkerCount/);

console.log('Arcane kernel-bound privilege boundary source and build contracts passed.');
