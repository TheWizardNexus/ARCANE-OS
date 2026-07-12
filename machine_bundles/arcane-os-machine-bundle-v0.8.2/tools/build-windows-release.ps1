param(
  [switch]$AllowUnsignedLocalRelease
)

$ErrorActionPreference = 'Stop'

# ARCANE_PUBLICATION_HELPERS_BEGIN
function Recover-ArcanePublication(
  [string]$Target,
  [string]$Stage,
  [string]$Backup,
  [scriptblock]$Verify
) {
  try {
    if (-not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Backup)) {
      & $Verify $Backup $false
      Move-Item -LiteralPath $Backup -Destination $Target
      & $Verify $Target $false
      Write-Warning "Recovered the previous verified Arcane publication at $Target."
    } elseif ((Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Backup)) {
      try {
        & $Verify $Target $false
        Remove-Item -LiteralPath $Backup -Recurse -Force
        Write-Host "Accepted the completed Arcane publication at $Target after interruption recovery."
      } catch {
        $targetFailure = $_.Exception.Message
        try {
          & $Verify $Backup $false
        } catch {
          throw "Neither interrupted Arcane publication can be accepted. Target: $targetFailure Backup: $($_.Exception.Message)"
        }
        Remove-Item -LiteralPath $Target -Recurse -Force
        Move-Item -LiteralPath $Backup -Destination $Target
        & $Verify $Target $false
        Write-Warning "Rolled back an incomplete Arcane publication at $Target."
      }
    } elseif (-not (Test-Path -LiteralPath $Target) -and -not (Test-Path -LiteralPath $Backup) -and (Test-Path -LiteralPath $Stage)) {
      try {
        & $Verify $Stage $false
        Move-Item -LiteralPath $Stage -Destination $Target
        & $Verify $Target $false
        Write-Warning "Recovered a fully verified staged Arcane publication at $Target."
      } catch {
        $stageFailure = $_.Exception.Message
        if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
        Write-Warning "Discarding an incomplete Arcane publication stage at ${Stage}: $stageFailure"
      }
    }
  } finally {
    if (Test-Path -LiteralPath $Stage) {
      Remove-Item -LiteralPath $Stage -Recurse -Force
      Write-Host "Removed stale Arcane publication stage $Stage."
    }
  }
}

function Publish-VerifiedArcaneDirectory(
  [string]$Stage,
  [string]$Target,
  [string]$Backup,
  [scriptblock]$Verify,
  [bool]$RequireSigned,
  [scriptblock]$ReplaceReproducibleTarget = $null
) {
  & $Verify $Stage $RequireSigned
  $hasRollback = $false
  if (Test-Path -LiteralPath $Backup) {
    throw "Arcane publication backup still exists after recovery: $Backup"
  }
  if (Test-Path -LiteralPath $Target) {
    try {
      & $Verify $Target $false
      Move-Item -LiteralPath $Target -Destination $Backup
      $hasRollback = $true
    } catch {
      if (-not $ReplaceReproducibleTarget) { throw }
      & $ReplaceReproducibleTarget $Target
      Remove-Item -LiteralPath $Target -Recurse -Force
      Write-Host "Replaced a verified reproducible Arcane build target without treating it as a native rollback."
    }
  }
  try {
    Move-Item -LiteralPath $Stage -Destination $Target
    & $Verify $Target $RequireSigned
    if (Test-Path -LiteralPath $Backup) {
      Remove-Item -LiteralPath $Backup -Recurse -Force
    }
  } catch {
    $publicationFailure = $_
    if ($hasRollback -and (Test-Path -LiteralPath $Backup)) {
      try {
        & $Verify $Backup $false
      } catch {
        throw "The new Arcane publication failed and its rollback copy is not verifiable; both trees were preserved. Publication: $($publicationFailure.Exception.Message) Rollback: $($_.Exception.Message)"
      }
      if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
      Move-Item -LiteralPath $Backup -Destination $Target
      & $Verify $Target $false
    } elseif (Test-Path -LiteralPath $Target) {
      Remove-Item -LiteralPath $Target -Recurse -Force
    }
    throw $publicationFailure
  }
}
# ARCANE_PUBLICATION_HELPERS_END

$root = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $root 'dist'
$target = Join-Path $distRoot 'windows'
$stage = Join-Path $distRoot '.windows.stage'
$backup = Join-Path $distRoot '.windows.backup'
$lockPath = Join-Path $distRoot '.windows.publish.lock'
$pkg = Join-Path $root 'node_modules\.bin\pkg.cmd'
$runtime = Join-Path $root 'runtime\arcane-core.cjs'
$generatedApp = Join-Path $distRoot 'app'
$generatedBundle = Join-Path $distRoot 'arcane-bundle.json'
$generatedApps = Join-Path $distRoot 'apps'

$expectedParent = [IO.Path]::GetFullPath($distRoot).TrimEnd('\')
foreach ($candidate in @($target, $stage, $backup, $lockPath)) {
  $resolved = [IO.Path]::GetFullPath($candidate)
  $resolvedParent = [IO.Path]::GetFullPath((Split-Path -Parent $resolved)).TrimEnd('\')
  if ($resolvedParent -ne $expectedParent) { throw "Refusing to build outside $expectedParent." }
}

$previousSigningPolicy = [Environment]::GetEnvironmentVariable('ARCANE_REQUIRE_SIGNED_RELEASE', 'Process')
$signingPolicy = ([string]$previousSigningPolicy).Trim()
if ($signingPolicy -and $signingPolicy -notin @('0', '1')) {
  throw 'ARCANE_REQUIRE_SIGNED_RELEASE must be exactly 0 or 1 when provided.'
}
if ($AllowUnsignedLocalRelease) {
  if ($signingPolicy -eq '1') { throw 'AllowUnsignedLocalRelease conflicts with ARCANE_REQUIRE_SIGNED_RELEASE=1.' }
  $requiredSigningPolicy = '0'
  $requireSignedRelease = $false
  $releaseFlavor = 'UNSIGNED LOCAL-TEST ALLOWED'
} else {
  if ($signingPolicy -eq '0') { throw 'Production Windows distribution conflicts with ARCANE_REQUIRE_SIGNED_RELEASE=0.' }
  $requiredSigningPolicy = '1'
  $requireSignedRelease = $true
  $releaseFlavor = 'PRODUCTION SIGNED'
}

function Assert-WindowsDistribution([string]$ReleaseRoot, [bool]$RequireSigned) {
  & node (Join-Path $root 'tools\verify-built-release.mjs') $ReleaseRoot
  if ($LASTEXITCODE -ne 0) { throw "Windows distribution exact verification failed for $ReleaseRoot." }
  $bundle = Get-Content -Raw -LiteralPath (Join-Path $ReleaseRoot 'arcane-bundle.json') | ConvertFrom-Json
  $contentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $ReleaseRoot 'arcane-machine-content.json')).Hash.ToLowerInvariant()
  $binding = "ARCANE-MACHINE-BINDING|1|$($bundle.version)|$contentHash"
  & (Join-Path $root 'tools\verify-windows-release-security.ps1') -ReleaseRoot $ReleaseRoot -ExpectedBinding $binding -RequireSigned:$RequireSigned
}

$verifyDistribution = {
  param([string]$Path, [bool]$RequireSigned)
  Assert-WindowsDistribution -ReleaseRoot $Path -RequireSigned $RequireSigned
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$lockStream = $null
try {
  try {
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    throw 'Another Arcane Windows distribution build is already publishing in this workspace.'
  }
  [Environment]::SetEnvironmentVariable('ARCANE_REQUIRE_SIGNED_RELEASE', $requiredSigningPolicy, 'Process')
  Write-Host "Arcane Windows distribution flavor: $releaseFlavor."

  Recover-ArcanePublication -Target $target -Stage $stage -Backup $backup -Verify $verifyDistribution

  if ($requireSignedRelease -and [string]::IsNullOrWhiteSpace([string]$env:ARCANE_SIGNING_CERT_THUMBPRINT)) {
    throw 'Production Windows distribution requires ARCANE_SIGNING_CERT_THUMBPRINT. Use the explicit unsigned-local-test build only for local verification.'
  }
  if ($requireSignedRelease -and [string]::IsNullOrWhiteSpace([string]$env:ARCANE_TIMESTAMP_SERVER)) {
    throw 'Production Windows distribution requires ARCANE_TIMESTAMP_SERVER.'
  }

  if (-not (Test-Path -LiteralPath $pkg -PathType Leaf)) { throw 'The pinned pkg build tool is missing. Run npm ci first.' }
  if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { throw 'The generated Arcane Core is missing. Run npm run build first.' }
  if (-not (Test-Path -LiteralPath $generatedApp -PathType Container) -or -not (Test-Path -LiteralPath $generatedBundle -PathType Leaf)) {
    throw 'The generated Arcane application payload is missing. Run npm run build first.'
  }

  # Target packages are part of the machine authenticity root, so the unified build
  # must finish them before it snapshots dist/apps into the staged release.
  $appBuildArguments = @((Join-Path $root 'tools\build-app.mjs'), '--all', '--platform=windows')
  if ($AllowUnsignedLocalRelease) { $appBuildArguments += '--allow-unsigned-local-release' }
  & node @appBuildArguments
  if ($LASTEXITCODE -ne 0) { throw 'Building the bound Windows application targets failed.' }
  if (-not (Test-Path -LiteralPath (Join-Path $generatedApps 'catalog.json') -PathType Leaf)) { throw 'The verified Windows app projection is missing.' }

  New-Item -ItemType Directory -Path (Join-Path $stage 'bin') -Force | Out-Null
  Copy-Item -LiteralPath $generatedApp -Destination (Join-Path $stage 'app') -Recurse
  Copy-Item -LiteralPath $generatedApps -Destination (Join-Path $stage 'apps') -Recurse
  Copy-Item -LiteralPath $generatedBundle -Destination (Join-Path $stage 'arcane-bundle.json')

  & $pkg $runtime '--targets' 'node22-win-x64' '--output' (Join-Path $stage 'bin\ArcaneCore.exe')
  if ($LASTEXITCODE -ne 0) { throw "Packaging ArcaneCore.exe failed with exit code $LASTEXITCODE." }

  & (Join-Path $root 'tools\build-windows-webview2.ps1') -Dist $stage
  if ($LASTEXITCODE -ne 0) { throw "Building the bound WebView2 hosts failed with exit code $LASTEXITCODE." }

  & node (Join-Path $root 'tools\write-release-manifest.mjs') windows $stage
  if ($LASTEXITCODE -ne 0) { throw 'Writing the outer Windows release manifest failed.' }

  Publish-VerifiedArcaneDirectory -Stage $stage -Target $target -Backup $backup -Verify $verifyDistribution -RequireSigned $requireSignedRelease
  Write-Host "Published $releaseFlavor bound Windows distribution to $target"
} finally {
  if (Test-Path -LiteralPath $stage) {
    try { Remove-Item -LiteralPath $stage -Recurse -Force }
    catch { Write-Warning "Deferred cleanup of $stage until the next locked build: $($_.Exception.Message)" }
  }
  [Environment]::SetEnvironmentVariable('ARCANE_REQUIRE_SIGNED_RELEASE', $previousSigningPolicy, 'Process')
  if ($lockStream) { $lockStream.Dispose() }
}
