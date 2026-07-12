import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [guard, core, windows, linux, host, windowsBuild, targetBuild, releaseIntegrity, targetFinalizer] = await Promise.all([
  fs.readFile(path.join(root, 'src/hosts/windows/ArcanePipeGuard.cs'), 'utf8'),
  fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/native/linux.cjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/hosts/windows/ArcaneHost.cs'), 'utf8'),
  fs.readFile(path.join(root, 'tools/build-windows-webview2.ps1'), 'utf8'),
  fs.readFile(path.join(root, 'tools/build-windows-target-app.ps1'), 'utf8'),
  fs.readFile(path.join(root, 'tools/release-integrity.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'tools/finalize-app-package.mjs'), 'utf8'),
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
assert.match(windows, /Get-AuthenticodeSignature/);
assert.match(windows, /guardThumbprint === coreThumbprint/);
assert.match(windows, /allowUnsignedLocalRelease/);
assert.match(host, /arg == "--allow-unsigned-local-release"/);

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
  assert.match(build, /\$requireSignedRelease -and -not \$timestampServer/);
  assert.match(build, /TimeStamperCertificate/);
}
assert.match(releaseIntegrity, /'ArcanePipeGuard\.exe'/);
assert.match(targetFinalizer, /pipeGuard: 'ArcanePipeGuard\.exe'/);

console.log('Arcane kernel-bound privilege boundary source and build contracts passed.');
