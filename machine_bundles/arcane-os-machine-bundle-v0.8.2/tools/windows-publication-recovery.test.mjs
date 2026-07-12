import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const beginMarker = '# ARCANE_PUBLICATION_HELPERS_BEGIN';
const endMarker = '# ARCANE_PUBLICATION_HELPERS_END';

function helpersFrom(source) {
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  assert(begin >= 0 && end > begin, 'publication helper markers are missing');
  return source.slice(begin + beginMarker.length, end).trim();
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

test('machine and target publication helpers recover every durable interruption state', { skip: process.platform !== 'win32' }, async () => {
  const [machineSource, targetSource] = await Promise.all([
    fs.readFile(path.join(root, 'tools/build-windows-release.ps1'), 'utf8'),
    fs.readFile(path.join(root, 'tools/build-windows-target-app.ps1'), 'utf8'),
  ]);
  const machineHelpers = helpersFrom(machineSource);
  const targetHelpers = helpersFrom(targetSource);
  assert.equal(targetHelpers, machineHelpers, 'machine and target publication transactions must use the same recovery semantics');

  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-publication-recovery-'));
  const helpersPath = path.join(fixture, 'helpers.ps1');
  const harnessPath = path.join(fixture, 'harness.ps1');
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(helpersPath)}
$fixture = ${quotePowerShell(fixture)}
$log = Join-Path $fixture 'verification.log'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Write-Artifact([string]$Path, [string]$Value, [bool]$Valid, [bool]$FailAfterPublish = $false) {
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $Path 'value.txt') -Value $Value -NoNewline
  Set-Content -LiteralPath (Join-Path $Path 'status.txt') -Value $(if ($Valid) { 'valid' } else { 'invalid' }) -NoNewline
  if ($FailAfterPublish) { Set-Content -LiteralPath (Join-Path $Path 'fail-after-publish.txt') -Value '1' -NoNewline }
}

$verify = {
  param([string]$Path, [bool]$RequireSigned)
  $status = Get-Content -Raw -LiteralPath (Join-Path $Path 'status.txt')
  Add-Content -LiteralPath $log -Value "$([IO.Path]::GetFileName($Path))|$RequireSigned|$status"
  if ($status -cne 'valid') { throw "invalid artifact $Path" }
  if ((Test-Path -LiteralPath (Join-Path $Path 'fail-after-publish.txt')) -and ([IO.Path]::GetFileName($Path) -eq 'target')) {
    throw "injected post-rename verification failure $Path"
  }
}
$replacePortable = {
  param([string]$Path)
  $status = Get-Content -Raw -LiteralPath (Join-Path $Path 'status.txt')
  if ($status -cne 'portable') { throw "target is not an exact reproducible portable package $Path" }
}

function New-Scenario([string]$Name) {
  $scenario = Join-Path $fixture $Name
  if (Test-Path -LiteralPath $scenario) { Remove-Item -LiteralPath $scenario -Recurse -Force }
  New-Item -ItemType Directory -Path $scenario | Out-Null
  return @{
    Target = Join-Path $scenario 'target'
    Stage = Join-Path $scenario 'stage'
    Backup = Join-Path $scenario 'backup'
  }
}

$paths = New-Scenario 'missing-target'
Write-Artifact $paths.Backup 'old' $true
Write-Artifact $paths.Stage 'stale' $false
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify
Assert-True (Test-Path -LiteralPath $paths.Target) 'missing target was not restored'
Assert-True (-not (Test-Path -LiteralPath $paths.Backup)) 'restored backup still exists'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'stale stage still exists'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'old') 'wrong backup was restored'

$paths = New-Scenario 'verified-stage-only'
Write-Artifact $paths.Stage 'new' $true
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'new') 'verified stage was not promoted after interruption'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'promoted stage still exists'

$paths = New-Scenario 'incomplete-stage-only'
Write-Artifact $paths.Stage 'partial' $false
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify
Assert-True (-not (Test-Path -LiteralPath $paths.Target)) 'incomplete stage was promoted'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'incomplete stage was not cleaned'

$paths = New-Scenario 'completed-target'
Write-Artifact $paths.Target 'new' $true
Write-Artifact $paths.Backup 'old' $true
Write-Artifact $paths.Stage 'stale' $false
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'new') 'completed target was replaced'
Assert-True (-not (Test-Path -LiteralPath $paths.Backup)) 'accepted target retained its backup'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'accepted target retained stale stage'

$paths = New-Scenario 'invalid-target'
Write-Artifact $paths.Target 'bad-new' $false
Write-Artifact $paths.Backup 'old' $true
Write-Artifact $paths.Stage 'stale' $false
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'old') 'invalid target did not roll back'
Assert-True (-not (Test-Path -LiteralPath $paths.Backup)) 'rollback backup was not consumed'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'rollback retained stale stage'

$paths = New-Scenario 'both-invalid'
Write-Artifact $paths.Target 'bad-new' $false
Write-Artifact $paths.Backup 'bad-old' $false
Write-Artifact $paths.Stage 'stale' $false
$rejected = $false
try {
  Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify
} catch {
  $rejected = $_.Exception.Message -like 'Neither interrupted Arcane publication can be accepted*'
}
Assert-True $rejected 'two invalid publications were not rejected'
Assert-True (Test-Path -LiteralPath $paths.Target) 'invalid target was not preserved for diagnosis'
Assert-True (Test-Path -LiteralPath $paths.Backup) 'invalid backup was not preserved for diagnosis'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'rejected recovery retained stale stage'

$paths = New-Scenario 'publish-success'
Write-Artifact $paths.Target 'old' $true
Write-Artifact $paths.Stage 'new' $true
Publish-VerifiedArcaneDirectory -Stage $paths.Stage -Target $paths.Target -Backup $paths.Backup -Verify $verify -RequireSigned $true
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'new') 'verified publication did not replace target'
Assert-True (-not (Test-Path -LiteralPath $paths.Backup)) 'backup was not removed after final target verification'

$paths = New-Scenario 'portable-to-native'
Write-Artifact $paths.Target 'portable' $false
Set-Content -LiteralPath (Join-Path $paths.Target 'status.txt') -Value 'portable' -NoNewline
Write-Artifact $paths.Stage 'native' $true
Publish-VerifiedArcaneDirectory -Stage $paths.Stage -Target $paths.Target -Backup $paths.Backup -Verify $verify -RequireSigned $true -ReplaceReproducibleTarget $replacePortable
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'native') 'portable target was not replaced by verified native stage'
Assert-True (-not (Test-Path -LiteralPath $paths.Backup)) 'portable target became a durable native rollback'

$paths = New-Scenario 'malformed-to-native'
Write-Artifact $paths.Target 'malformed' $false
Write-Artifact $paths.Stage 'native' $true
$rejected = $false
try {
  Publish-VerifiedArcaneDirectory -Stage $paths.Stage -Target $paths.Target -Backup $paths.Backup -Verify $verify -RequireSigned $true -ReplaceReproducibleTarget $replacePortable
} catch {
  $rejected = $_.Exception.Message -like 'target is not an exact reproducible portable package*'
}
Assert-True $rejected 'malformed existing target was downgraded to the portable replacement exception'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'malformed') 'malformed target was mutated after rejection'
Assert-True (Test-Path -LiteralPath $paths.Stage) 'verified stage was removed after rejecting malformed target'

$paths = New-Scenario 'publish-failure'
Write-Artifact $paths.Target 'old' $true
Write-Artifact $paths.Stage 'bad-new' $true $true
$rejected = $false
try {
  Publish-VerifiedArcaneDirectory -Stage $paths.Stage -Target $paths.Target -Backup $paths.Backup -Verify $verify -RequireSigned $true
} catch {
  $rejected = $_.Exception.Message -like 'injected post-rename verification failure*'
}
Assert-True $rejected 'post-rename verification failure was not surfaced'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'old') 'failed publication did not restore verified rollback'
Assert-True (-not (Test-Path -LiteralPath $paths.Backup)) 'failed publication left backup after rollback'

Write-Host 'Arcane publication recovery interruption matrix passed.'
`;

  try {
    await fs.writeFile(helpersPath, `${machineHelpers}\n`, 'utf8');
    await fs.writeFile(harnessPath, harness, 'utf8');
    const result = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath,
    ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, `${result.stdout || ''}\n${result.stderr || ''}`);
    assert.match(result.stdout, /Arcane publication recovery interruption matrix passed/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
