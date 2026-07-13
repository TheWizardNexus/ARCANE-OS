import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const modulePath = path.join(here, 'windows-signing.psm1');
const wrapperPath = path.join(here, 'build-windows-signed.ps1');
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const unavailableThumbprint = '0000000000000000000000000000000000000001';
const testTimestampServer = 'https://timestamp.invalid';

function cleanSigningEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of [
    'ARCANE_REQUIRE_SIGNED_RELEASE',
    'ARCANE_SIGNING_CERT_THUMBPRINT',
    'ARCANE_EXPECTED_PUBLISHER_THUMBPRINT',
    'ARCANE_TIMESTAMP_SERVER',
    'ARCANE_SIGNTOOL_PATH',
  ]) {
    delete environment[name];
  }
  return { ...environment, ...overrides };
}

function runPreflight(arguments_, environment = cleanSigningEnvironment()) {
  return spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', wrapperPath,
    ...arguments_,
    '-PreflightOnly',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    timeout: 15000,
    windowsHide: true,
  });
}

function diagnostics(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

function assertRejected(result, expected) {
  assert.notEqual(result.status, 0, `preflight unexpectedly succeeded:\n${diagnostics(result)}`);
  assert.equal(result.signal, null, `preflight was terminated by ${result.signal}:\n${diagnostics(result)}`);
  assert.match(diagnostics(result), expected);
}

test('shared Windows signing module owns the secretless Authenticode contract', async () => {
  const [moduleSource, wrapperSource] = await Promise.all([
    fs.readFile(modulePath, 'utf8'),
    fs.readFile(wrapperPath, 'utf8'),
  ]);
  const contractSource = `${moduleSource}\n${wrapperSource}`;

  for (const name of [
    'Resolve-ArcaneWindowsSigningContext',
    'Invoke-ArcaneAuthenticodeSign',
    'Get-ArcaneSignedWindowsBuildPlan',
  ]) {
    assert.match(moduleSource, new RegExp(`function\\s+${name.replaceAll('-', '\\-')}\\b`, 'i'));
    assert.match(moduleSource, new RegExp(`Export-ModuleMember[\\s\\S]*${name.replaceAll('-', '\\-')}`, 'i'));
  }

  assert.match(moduleSource, /Cert:\\CurrentUser\\My/i);
  assert.match(moduleSource, /Cert:\\LocalMachine\\My/i);
  assert.match(moduleSource, /CodeSigningCert/i);
  assert.match(moduleSource, /HasPrivateKey/i);
  assert.match(moduleSource, /Get-AuthenticodeSignature/i);
  assert.match(moduleSource, /TimeStamperCertificate/i);
  assert.match(moduleSource, /SignerCertificate[\s\S]*Thumbprint/i);
  assert.match(moduleSource, /['"]sign['"]/i);
  assert.match(moduleSource, /['"]\/sha1['"]/i);
  assert.match(moduleSource, /['"]\/fd['"][\s\S]*['"]SHA256['"]/i);
  assert.match(moduleSource, /['"]\/tr['"]/i);
  assert.match(moduleSource, /['"]\/td['"][\s\S]*['"]SHA256['"]/i);
  assert.match(moduleSource, /LASTEXITCODE[\s\S]*(?:throw|exit)/i);

  for (const script of [
    'build:distribution:windows',
    'build:apps:windows',
    'build:app:windows',
  ]) {
    assert.match(moduleSource, new RegExp(script.replaceAll(':', '\\:'), 'i'));
  }
  assert.match(moduleSource, /--app(?:=|['"])/i);
  assert.match(wrapperSource, /ValidateSet\([\s\S]*['"]release['"][\s\S]*['"]apps['"][\s\S]*['"]app['"][\s\S]*\)/i);
  assert.match(wrapperSource, /PreflightOnly/i);
  assert.match(wrapperSource, /Import-Module[\s\S]*windows-signing\.psm1/i);
  assert.match(wrapperSource, /Resolve-ArcaneWindowsSigningContext/i);
  assert.match(wrapperSource, /Get-ArcaneSignedWindowsBuildPlan/i);
  assert.match(wrapperSource, /LASTEXITCODE[\s\S]*(?:throw|exit)/i);

  for (const name of [
    'ARCANE_REQUIRE_SIGNED_RELEASE',
    'ARCANE_SIGNING_CERT_THUMBPRINT',
    'ARCANE_EXPECTED_PUBLISHER_THUMBPRINT',
    'ARCANE_TIMESTAMP_SERVER',
    'ARCANE_SIGNTOOL_PATH',
  ]) {
    assert.match(contractSource, new RegExp(name));
  }
  assert.match(contractSource, /ARCANE_REQUIRE_SIGNED_RELEASE[\s\S]*['"]1['"]/i);
  assert.doesNotMatch(contractSource, /AllowUnsignedLocalRelease|allow-unsigned-local-release/i);
  assert.doesNotMatch(contractSource, /Import-PfxCertificate|\.pfx\b|\.p12\b|PfxPassword|CertificatePassword/i);
  assert.doesNotMatch(contractSource, /\bsetx(?:\.exe)?\b|EnvironmentVariableTarget\]::(?:User|Machine)/i);
});

test('local development signing creates only a non-exportable current-user identity and delegates to the shared signer', async () => {
  const source = await fs.readFile(path.join(here, 'build-windows-dev-signed.ps1'), 'utf8');
  assert.match(source, /New-SelfSignedCertificate/);
  assert.match(source, /-Type CodeSigningCert/);
  assert.match(source, /CN=The Wizard Nexus Development/);
  assert.match(source, /Cert:\\CurrentUser\\My/);
  assert.match(source, /-KeyAlgorithm RSA/);
  assert.match(source, /-KeyLength 3072/);
  assert.match(source, /-HashAlgorithm SHA256/);
  assert.match(source, /-KeyExportPolicy NonExportable/);
  assert.match(source, /certutil\.exe/i);
  assert.match(source, /-user -f -addstore/);
  assert.match(source, /Test-ArcaneDevelopmentCertificate/);
  assert.match(source, /CngExportPolicies\]::None/);
  assert.match(source, /CspKeyContainerInfo\.Exportable/);
  assert.match(source, /StoreName 'Root'/);
  assert.match(source, /StoreName 'TrustedPublisher'/);
  assert.match(source, /if \(\$BootstrapOnly\) \{[\s\S]*StoreName 'Root'[\s\S]*StoreName 'TrustedPublisher'/);
  assert.match(source, /build-windows-signed\.ps1/);
  assert.match(source, /BootstrapOnly[\s\S]*PreflightOnly/);
  assert.match(source, /finally \{[\s\S]*SetEnvironmentVariable\(\$name, \$previousEnvironment\[\$name\], 'Process'\)/);
  assert.doesNotMatch(source, /Cert:\\LocalMachine|StoreLocation\]::LocalMachine/);
  assert.doesNotMatch(source, /AllowUnsignedLocalRelease|allow-unsigned-local-release/i);
  assert.doesNotMatch(source, /Export-PfxCertificate|X509ContentType\]::Pfx|SecureString|CertificatePassword|\.pfx\b/i);
  assert.doesNotMatch(source, /EnvironmentVariableTarget\]::(?:User|Machine)|\bsetx(?:\.exe)?\b/i);
});

test('signed-build preflight rejects a missing certificate thumbprint before any build', { skip: process.platform !== 'win32' }, () => {
  const result = runPreflight([
    '-Target', 'release',
    '-TimestampServer', testTimestampServer,
  ]);
  assertRejected(result, /(?:ARCANE_SIGNING_CERT_THUMBPRINT|certificate thumbprint).*(?:required|provide|missing)/is);
});

test('signed-build preflight rejects a malformed certificate thumbprint before any build', { skip: process.platform !== 'win32' }, () => {
  const result = runPreflight([
    '-Target', 'release',
    '-CertificateThumbprint', 'not-a-certificate-thumbprint',
    '-TimestampServer', testTimestampServer,
  ]);
  assertRejected(result, /(?:certificate thumbprint|ARCANE_SIGNING_CERT_THUMBPRINT).*(?:hex|invalid|malformed|40)/is);
});

test('signed-build preflight rejects a missing RFC 3161 timestamp server before any build', { skip: process.platform !== 'win32' }, () => {
  const result = runPreflight([
    '-Target', 'release',
    '-CertificateThumbprint', unavailableThumbprint,
  ]);
  assertRejected(result, /(?:ARCANE_TIMESTAMP_SERVER|timestamp server).*(?:required|provide|missing)/is);
});

test('signed-build preflight rejects timestamp URLs carrying credentials or query tokens', { skip: process.platform !== 'win32' }, () => {
  const result = runPreflight([
    '-Target', 'release',
    '-CertificateThumbprint', unavailableThumbprint,
    '-TimestampServer', 'https://publisher:secret@timestamp.invalid/rfc3161?token=secret',
  ]);
  assertRejected(result, /ARCANE_TIMESTAMP_SERVER.*(?:public|credentials|query)/is);
  assert.doesNotMatch(diagnostics(result), /publisher:secret|token=secret/);
});

test('signed-build preflight rejects a well-formed certificate that is unavailable for signing', { skip: process.platform !== 'win32' }, () => {
  const result = runPreflight([
    '-Target', 'release',
    '-CertificateThumbprint', unavailableThumbprint,
    '-TimestampServer', testTimestampServer,
  ]);
  assertRejected(result, /certificate.*(?:unavailable|not (?:available|found|identify)|private key)/is);
});

test('signed-build wrapper exposes no unsigned or iteration target', { skip: process.platform !== 'win32' }, () => {
  const result = runPreflight(['-Target', 'iteration']);
  assertRejected(result, /(?:ValidateSet|Target).*(?:iteration|release|apps|app)/is);
});
