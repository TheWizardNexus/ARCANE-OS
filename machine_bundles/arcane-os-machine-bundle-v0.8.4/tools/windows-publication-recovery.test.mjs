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
  if ($status -cne 'valid' -and $status -cne 'unsigned') { throw "invalid artifact $Path" }
  if ($RequireSigned -and $status -ceq 'unsigned') { throw "unsigned artifact $Path" }
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
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
Assert-True (Test-Path -LiteralPath $paths.Target) 'missing target was not restored'
Assert-True (-not (Test-Path -LiteralPath $paths.Backup)) 'restored backup still exists'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'stale stage still exists'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'old') 'wrong backup was restored'

$paths = New-Scenario 'verified-stage-only'
Write-Artifact $paths.Stage 'new' $true
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'new') 'verified stage was not promoted after interruption'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'promoted stage still exists'

$paths = New-Scenario 'unsigned-stage-local-recovery'
Write-Artifact $paths.Stage 'local' $true
Set-Content -LiteralPath (Join-Path $paths.Stage 'status.txt') -Value 'unsigned' -NoNewline
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'local') 'explicit local recovery rejected a verified unsigned stage'

$paths = New-Scenario 'unsigned-stage-production-recovery'
Write-Artifact $paths.Stage 'local' $true
Set-Content -LiteralPath (Join-Path $paths.Stage 'status.txt') -Value 'unsigned' -NoNewline
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $true
Assert-True (-not (Test-Path -LiteralPath $paths.Target)) 'production recovery promoted an unsigned stage'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'production recovery retained the rejected unsigned stage'

$paths = New-Scenario 'incomplete-stage-only'
Write-Artifact $paths.Stage 'partial' $false
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
Assert-True (-not (Test-Path -LiteralPath $paths.Target)) 'incomplete stage was promoted'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'incomplete stage was not cleaned'

$paths = New-Scenario 'completed-target'
Write-Artifact $paths.Target 'new' $true
Write-Artifact $paths.Backup 'old' $true
Write-Artifact $paths.Stage 'stale' $false
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'new') 'completed target was replaced'
Assert-True (-not (Test-Path -LiteralPath $paths.Backup)) 'accepted target retained its backup'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'accepted target retained stale stage'

$paths = New-Scenario 'completed-target-locked-backup'
Write-Artifact $paths.Target 'new' $true
Write-Artifact $paths.Backup 'old' $true
$lockedBackupFile = Join-Path $paths.Backup 'value.txt'
$lockedBackupStream = [IO.File]::Open($lockedBackupFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
} finally {
  $lockedBackupStream.Dispose()
}
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'new') 'backup cleanup failure replaced the verified target'
Assert-True (Test-Path -LiteralPath $paths.Backup) 'backup cleanup failure did not preserve the locked backup'

$paths = New-Scenario 'invalid-target'
Write-Artifact $paths.Target 'bad-new' $false
Write-Artifact $paths.Backup 'old' $true
Write-Artifact $paths.Stage 'stale' $false
Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'old') 'invalid target did not roll back'
Assert-True (-not (Test-Path -LiteralPath $paths.Backup)) 'rollback backup was not consumed'
Assert-True (-not (Test-Path -LiteralPath $paths.Stage)) 'rollback retained stale stage'

$paths = New-Scenario 'invalid-target-locked-backup'
Write-Artifact $paths.Target 'bad-new' $false
Write-Artifact $paths.Backup 'old' $true
Write-Artifact $paths.Stage 'stale' $false
$lockedRollbackStream = [IO.File]::Open((Join-Path $paths.Backup 'value.txt'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$rollbackRejected = $false
try {
  Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
} catch {
  $rollbackRejected = $_.Exception.Message -like 'Arcane could not restore the verified rollback publication*'
} finally {
  $lockedRollbackStream.Dispose()
}
Assert-True $rollbackRejected 'locked recovery rollback was not surfaced'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'bad-new') 'locked recovery rollback left the canonical target missing'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Backup 'value.txt')) -ceq 'old') 'locked recovery rollback mutated the preserved backup'
Assert-True (-not (Test-Path -LiteralPath ($paths.Target + '.rejected'))) 'locked recovery rollback left an unnecessary quarantine after restoring the target'

$paths = New-Scenario 'restart-after-target-quarantine'
Write-Artifact ($paths.Target + '.rejected') 'bad-new' $false
Write-Artifact $paths.Backup 'old' $true
$lockedRestartBackup = [IO.File]::Open((Join-Path $paths.Backup 'value.txt'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$restartRejected = $false
try {
  Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
} catch {
  $restartRejected = $_.Exception.Message -like 'Arcane could not restore the verified rollback publication*'
} finally {
  $lockedRestartBackup.Dispose()
}
Assert-True $restartRejected 'restart with a locked rollback was not surfaced'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'bad-new') 'restart left the canonical target missing despite a restorable rejected publication'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Backup 'value.txt')) -ceq 'old') 'restart mutated the locked rollback'

$paths = New-Scenario 'unresolved-partial-rollback'
Write-Artifact $paths.Target 'current' $true
Write-Artifact $paths.Backup 'old' $true
Write-Artifact ($paths.Backup + '.partial') 'partial' $false
$partialRejected = $false
try {
  Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
} catch {
  $partialRejected = $_.Exception.Message -like 'Arcane preserved an unresolved partial rollback*'
}
Assert-True $partialRejected 'an unresolved partial rollback did not block later publication'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'current') 'partial rollback handling mutated the canonical target'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Backup 'value.txt')) -ceq 'old') 'partial rollback handling mutated the backup'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path ($paths.Backup + '.partial') 'value.txt')) -ceq 'partial') 'partial rollback handling discarded diagnostic state'

$paths = New-Scenario 'both-invalid'
Write-Artifact $paths.Target 'bad-new' $false
Write-Artifact $paths.Backup 'bad-old' $false
Write-Artifact $paths.Stage 'stale' $false
$rejected = $false
try {
  Recover-ArcanePublication -Target $paths.Target -Stage $paths.Stage -Backup $paths.Backup -Verify $verify -RequireSigned $false
} catch {
  $rejected = $_.Exception.Message -like 'Arcane could not restore the verified rollback publication*'
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

$paths = New-Scenario 'publish-success-locked-backup'
Write-Artifact $paths.Target 'old' $true
Write-Artifact $paths.Stage 'new' $true
$script:basePublicationVerify = $verify
$script:publicationBackupLock = $null
$verifyAndLockBackup = {
  param([string]$Path, [bool]$RequireSigned)
  & $script:basePublicationVerify $Path $RequireSigned
  if ([IO.Path]::GetFileName($Path) -eq 'target' -and (Test-Path -LiteralPath $paths.Backup) -and -not $script:publicationBackupLock) {
    $script:publicationBackupLock = [IO.File]::Open((Join-Path $paths.Backup 'value.txt'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  }
}
$cleanupRejected = $false
try {
  Publish-VerifiedArcaneDirectory -Stage $paths.Stage -Target $paths.Target -Backup $paths.Backup -Verify $verifyAndLockBackup -RequireSigned $true
} catch {
  $cleanupRejected = $true
} finally {
  if ($script:publicationBackupLock) { $script:publicationBackupLock.Dispose(); $script:publicationBackupLock = $null }
}
Assert-True $cleanupRejected 'locked publication backup cleanup did not surface an error'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'new') 'backup cleanup failure deleted the verified new publication'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Backup 'value.txt')) -ceq 'old') 'backup cleanup failure mutated the preserved rollback'

$paths = New-Scenario 'production-refuses-unsigned-rollback'
Write-Artifact $paths.Target 'local-old' $true
Set-Content -LiteralPath (Join-Path $paths.Target 'status.txt') -Value 'unsigned' -NoNewline
Write-Artifact $paths.Stage 'signed-new' $true
$rejected = $false
try {
  Publish-VerifiedArcaneDirectory -Stage $paths.Stage -Target $paths.Target -Backup $paths.Backup -Verify $verify -RequireSigned $true
} catch {
  $rejected = $_.Exception.Message -like 'unsigned artifact*'
}
Assert-True $rejected 'production publication accepted an unsigned rollback candidate'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'local-old') 'rejected unsigned rollback candidate was mutated'
Assert-True (Test-Path -LiteralPath $paths.Stage) 'signed stage was removed after rejecting an unsigned rollback candidate'

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

$paths = New-Scenario 'publish-failure-locked-rollback'
Write-Artifact $paths.Target 'old' $true
Write-Artifact $paths.Stage 'bad-new' $true $true
$script:lockedRollbackStream = $null
$verifyAndLockFailedRollback = {
  param([string]$Path, [bool]$RequireSigned)
  $status = Get-Content -Raw -LiteralPath (Join-Path $Path 'status.txt')
  if ($status -cne 'valid' -and $status -cne 'unsigned') { throw "invalid artifact $Path" }
  if ($RequireSigned -and $status -ceq 'unsigned') { throw "unsigned artifact $Path" }
  if ((Test-Path -LiteralPath (Join-Path $Path 'fail-after-publish.txt')) -and ([IO.Path]::GetFileName($Path) -eq 'target')) {
    $script:lockedRollbackStream = [IO.File]::Open((Join-Path $paths.Backup 'value.txt'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    throw "injected locked post-rename verification failure $Path"
  }
}
$rejected = $false
try {
  Publish-VerifiedArcaneDirectory -Stage $paths.Stage -Target $paths.Target -Backup $paths.Backup -Verify $verifyAndLockFailedRollback -RequireSigned $true
} catch {
  $rejected = $_.Exception.Message -like 'The new Arcane publication failed and its rollback could not be restored*'
} finally {
  if ($script:lockedRollbackStream) { $script:lockedRollbackStream.Dispose(); $script:lockedRollbackStream = $null }
}
Assert-True $rejected 'locked post-publication rollback failure was not surfaced'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Target 'value.txt')) -ceq 'bad-new') 'locked post-publication rollback left the canonical target missing'
Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $paths.Backup 'value.txt')) -ceq 'old') 'locked post-publication rollback mutated the preserved backup'
Assert-True (-not (Test-Path -LiteralPath ($paths.Target + '.rejected'))) 'locked post-publication rollback left an unnecessary quarantine after restoring the target'

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
