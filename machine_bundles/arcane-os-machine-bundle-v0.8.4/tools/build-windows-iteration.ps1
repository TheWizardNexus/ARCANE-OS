param([switch]$Fast)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$distRoot = [IO.Path]::GetFullPath((Join-Path $root 'dist')).TrimEnd('\')
$target = Join-Path $distRoot 'nt-iteration'
$stage = Join-Path $distRoot ".nt-iteration.stage-$PID"
$backup = Join-Path $distRoot '.nt-iteration.backup'
$lockPath = Join-Path $distRoot '.windows-iteration.lock'
$legacyBackup = Join-Path $distRoot '.windows-iteration.backup'
$runtime = Join-Path $root 'runtime\arcane-core.cjs'
$generatedApp = Join-Path $distRoot 'app'
$generatedApps = Join-Path $distRoot 'apps'
$generatedBundle = Join-Path $distRoot 'arcane-bundle.json'
$pkg = Join-Path $root 'node_modules\@yao-pkg\pkg\lib-es5\bin.js'

function Assert-IterationPath([string]$Path) {
  $resolved = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetFullPath((Split-Path -Parent $resolved)).TrimEnd('\')
  if ($parent -ne $distRoot) { throw "Refusing to mutate an iteration path outside $distRoot." }
  return $resolved
}

foreach ($candidate in @($target, $stage, $backup, $lockPath, $legacyBackup)) {
  [void](Assert-IterationPath $candidate)
}

function Invoke-NodeChecked([string[]]$Arguments, [string]$Failure) {
  & node @Arguments
  if ($LASTEXITCODE -ne 0) { throw $Failure }
}

function Assert-IterationRelease([string]$ReleaseRoot) {
  Invoke-NodeChecked -Arguments @((Join-Path $root 'tools\verify-built-release.mjs'), $ReleaseRoot) -Failure "Iteration release verification failed for $ReleaseRoot."
  $bundle = Get-Content -Raw -LiteralPath (Join-Path $ReleaseRoot 'arcane-bundle.json') | ConvertFrom-Json
  $contentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $ReleaseRoot 'arcane-machine-content.json')).Hash.ToLowerInvariant()
  $binding = "ARCANE-MACHINE-BINDING|1|$($bundle.version)|$contentHash"
  & (Join-Path $root 'tools\verify-windows-release-security.ps1') -ReleaseRoot $ReleaseRoot -ExpectedBinding $binding
  if ($LASTEXITCODE -ne 0) { throw "Iteration native security verification failed for $ReleaseRoot." }
}

function Recover-IterationPublication {
  if (-not (Test-Path -LiteralPath $backup)) { return }
  if (-not (Test-Path -LiteralPath $target)) {
    Assert-IterationRelease $backup
    Move-Item -LiteralPath $backup -Destination $target
    Assert-IterationRelease $target
    Write-Warning 'Recovered the previous verified Microsoft NT iteration release after an interrupted publication.'
    return
  }
  try {
    Assert-IterationRelease $target
    Remove-Item -LiteralPath $backup -Recurse -Force
    Write-Warning 'Accepted the verified Microsoft NT iteration release and removed its stale backup.'
  } catch {
    $targetFailure = $_.Exception.Message
    Assert-IterationRelease $backup
    Remove-Item -LiteralPath $target -Recurse -Force
    Move-Item -LiteralPath $backup -Destination $target
    Assert-IterationRelease $target
    Write-Warning "Restored the previous verified Microsoft NT iteration release. Rejected target: $targetFailure"
  }
}

$environmentNames = @(
  'ARCANE_REQUIRE_SIGNED_RELEASE',
  'ARCANE_SIGNING_CERT_THUMBPRINT',
  'ARCANE_EXPECTED_PUBLISHER_THUMBPRINT',
  'ARCANE_TIMESTAMP_SERVER'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$lockStream = $null
try {
  try {
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    throw 'Another Arcane Microsoft NT iteration build is already running.'
  }

  $legacyIterationState = @()
  if (Test-Path -LiteralPath $legacyBackup) { $legacyIterationState += $legacyBackup }
  $legacyIterationState += @(Get-ChildItem -LiteralPath $distRoot -Filter '.windows-iteration.stage-*' -Force -ErrorAction Stop |
    Select-Object -ExpandProperty FullName)
  if ($legacyIterationState.Count) {
    throw "Arcane found unresolved legacy Microsoft NT iteration publication state: $($legacyIterationState -join ', '). Finish recovery with the pre-cutover builder or review the preserved paths before building dist\nt-iteration."
  }

  [Environment]::SetEnvironmentVariable('ARCANE_REQUIRE_SIGNED_RELEASE', '0', 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_SIGNING_CERT_THUMBPRINT', $null, 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_EXPECTED_PUBLISHER_THUMBPRINT', $null, 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_TIMESTAMP_SERVER', $null, 'Process')

  Recover-IterationPublication
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }

  Write-Host 'Building an isolated unsigned Microsoft NT iteration release (Core and machine hosts only).'
  Invoke-NodeChecked -Arguments @((Join-Path $root 'tools\build-core.mjs')) -Failure 'Generating the Arcane Core and built-in frontend payload failed.'
  if (-not $Fast) {
    Invoke-NodeChecked -Arguments @((Join-Path $root 'tools\verify.mjs')) -Failure 'Generated Core/frontend verification failed.'
  }

  if (-not (Test-Path -LiteralPath $generatedApps -PathType Container) -or
      -not (Test-Path -LiteralPath (Join-Path $generatedApps 'catalog.json') -PathType Leaf)) {
    throw 'No reusable verified Microsoft NT app projection exists. Run npm run build:distribution:windows:unsigned-local-test once.'
  }
  if (-not $Fast) {
    Invoke-NodeChecked -Arguments @((Join-Path $root 'tools\verify-app-packages.mjs')) -Failure 'The reusable target app packages are not verified.'
    Invoke-NodeChecked -Arguments @((Join-Path $root 'tools\verify-app-catalog.mjs')) -Failure 'The reusable Microsoft NT app projection is not verified.'
  }

  foreach ($required in @($pkg, $runtime, $generatedApp, $generatedBundle)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "The iteration build input is missing: $required" }
  }

  New-Item -ItemType Directory -Path (Join-Path $stage 'bin') -Force | Out-Null
  Copy-Item -LiteralPath $generatedApp -Destination (Join-Path $stage 'app') -Recurse
  Copy-Item -LiteralPath $generatedApps -Destination (Join-Path $stage 'apps') -Recurse
  Copy-Item -LiteralPath $generatedBundle -Destination (Join-Path $stage 'arcane-bundle.json')

& node $pkg $runtime '--targets' 'node22-win-x64' '--output' (Join-Path $stage 'bin\ArcaneCore.exe')
  if ($LASTEXITCODE -ne 0) { throw "Packaging the iteration ArcaneCore.exe failed with exit code $LASTEXITCODE." }

  & (Join-Path $root 'tools\build-windows-webview2.ps1') -Dist $stage -SkipRuntimeVerification:$Fast
  if ($LASTEXITCODE -ne 0) { throw "Building the iteration Microsoft NT hosts failed with exit code $LASTEXITCODE." }

  Invoke-NodeChecked -Arguments @((Join-Path $root 'tools\write-release-manifest.mjs'), 'windows', $stage) -Failure 'Writing the iteration release manifest failed.'
  Assert-IterationRelease $stage

  $hadTarget = Test-Path -LiteralPath $target
  if ($hadTarget) {
    if (Test-Path -LiteralPath $backup) { throw "The iteration backup still exists after recovery: $backup" }
    try { Move-Item -LiteralPath $target -Destination $backup }
    catch { throw "Close the running iteration Provisioner/Shell before rebuilding. The previous release remains at $target. $($_.Exception.Message)" }
  }
  try {
    Move-Item -LiteralPath $stage -Destination $target
    Assert-IterationRelease $target
  } catch {
    $publicationFailure = $_
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    if ($hadTarget -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $target }
    throw $publicationFailure
  }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }

  Write-Host "Microsoft NT iteration release ready: $target"
  Write-Host "Launch: $target\bin\ArcaneProvisioner.exe --allow-unsigned-local-release"
} finally {
  if (Test-Path -LiteralPath $stage) {
    try { Remove-Item -LiteralPath $stage -Recurse -Force }
    catch { Write-Warning "Could not remove the incomplete iteration stage at ${stage}: $($_.Exception.Message)" }
  }
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
  if ($lockStream) { $lockStream.Dispose() }
}
