param(
  [switch]$AllowUnsignedLocalRelease
)

$ErrorActionPreference = 'Stop'

# ARCANE_PUBLICATION_HELPERS_BEGIN
function Restore-ArcanePublicationBackup(
  [string]$Target,
  [string]$Backup,
  [scriptblock]$Verify,
  [bool]$RequireSigned
) {
  $quarantine = "$Target.rejected"
  if (Test-Path -LiteralPath $quarantine) { throw "Arcane preserved an unresolved rejected publication at $quarantine." }
  & $Verify $Backup $RequireSigned
  $movedTarget = $false
  if (Test-Path -LiteralPath $Target) {
    Move-Item -LiteralPath $Target -Destination $quarantine
    $movedTarget = $true
  }
  try {
    Move-Item -LiteralPath $Backup -Destination $Target
    & $Verify $Target $RequireSigned
  } catch {
    $restoreFailure = $_
    $partialRollback = "$Backup.partial"
    if ((Test-Path -LiteralPath $Target) -and $movedTarget -and (Test-Path -LiteralPath $quarantine)) {
      try {
        if (Test-Path -LiteralPath $partialRollback) { throw "Arcane preserved an unresolved partial rollback at $partialRollback." }
        if (Test-Path -LiteralPath $Backup) {
          Move-Item -LiteralPath $Target -Destination $partialRollback
        } else {
          Move-Item -LiteralPath $Target -Destination $Backup
        }
      } catch {
        throw "Arcane preserved the rejected publication, but could not move the partial rollback away from the canonical path. Rollback: $($restoreFailure.Exception.Message) Partial: $($_.Exception.Message)"
      }
    }
    if (-not (Test-Path -LiteralPath $Target) -and $movedTarget -and (Test-Path -LiteralPath $quarantine)) {
      try {
        Move-Item -LiteralPath $quarantine -Destination $Target
      } catch {
        throw "Arcane could not restore the rejected publication to the canonical path. Rollback: $($restoreFailure.Exception.Message) Original: $($_.Exception.Message)"
      }
    }
    throw $restoreFailure
  }
  if ($movedTarget -and (Test-Path -LiteralPath $quarantine)) {
    try { Remove-Item -LiteralPath $quarantine -Recurse -Force }
    catch { Write-Warning "The verified rollback is active, but its rejected replacement remains at $($quarantine): $($_.Exception.Message)" }
  }
}

function Recover-ArcanePublication(
  [string]$Target,
  [string]$Stage,
  [string]$Backup,
  [scriptblock]$Verify,
  [bool]$RequireSigned
) {
  $quarantine = "$Target.rejected"
  $partialRollback = "$Backup.partial"
  try {
    if (-not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $quarantine)) {
      Move-Item -LiteralPath $quarantine -Destination $Target
      Write-Warning "Restored the rejected Arcane publication before examining its rollback state."
    }
    if (Test-Path -LiteralPath $partialRollback) {
      throw "Arcane preserved an unresolved partial rollback at $partialRollback. Review it before publishing again."
    }
    if (-not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Backup)) {
      & $Verify $Backup $RequireSigned
      Move-Item -LiteralPath $Backup -Destination $Target
      & $Verify $Target $RequireSigned
      Write-Warning "Recovered the previous verified Arcane publication at $Target."
    } elseif ((Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Backup)) {
      $targetVerified = $false
      $targetFailure = $null
      try {
        & $Verify $Target $RequireSigned
        $targetVerified = $true
      } catch {
        $targetFailure = $_.Exception.Message
      }
      if ($targetVerified) {
        try {
          Remove-Item -LiteralPath $Backup -Recurse -Force
          Write-Host "Accepted the completed Arcane publication at $Target after interruption recovery."
        } catch {
          Write-Warning "The verified Arcane publication at $Target was preserved, but its stale backup could not be removed: $($_.Exception.Message)"
        }
      } else {
        try {
          Restore-ArcanePublicationBackup -Target $Target -Backup $Backup -Verify $Verify -RequireSigned $RequireSigned
        } catch {
          throw "Arcane could not restore the verified rollback publication. Target: $targetFailure Rollback: $($_.Exception.Message)"
        }
        Write-Warning "Rolled back an incomplete Arcane publication at $Target."
      }
    } elseif (-not (Test-Path -LiteralPath $Target) -and -not (Test-Path -LiteralPath $Backup) -and (Test-Path -LiteralPath $Stage)) {
      try {
        & $Verify $Stage $RequireSigned
        Move-Item -LiteralPath $Stage -Destination $Target
        & $Verify $Target $RequireSigned
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
    $quarantine = "$Target.rejected"
    if ((Test-Path -LiteralPath $quarantine) -and (Test-Path -LiteralPath $Target) -and -not (Test-Path -LiteralPath $Backup)) {
      try {
        & $Verify $Target $RequireSigned
        Remove-Item -LiteralPath $quarantine -Recurse -Force
        Write-Host "Removed a stale rejected Arcane publication at $quarantine."
      } catch {
        Write-Warning "Arcane preserved unresolved publication state at $($quarantine): $($_.Exception.Message)"
      }
    } elseif ((Test-Path -LiteralPath $quarantine) -and -not (Test-Path -LiteralPath $Target)) {
      Move-Item -LiteralPath $quarantine -Destination $Target
      Write-Warning "Restored the rejected Arcane publication so the canonical path would not remain missing."
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
    $targetVerified = $false
    try {
      & $Verify $Target $RequireSigned
      $targetVerified = $true
    } catch {
      if (-not $ReplaceReproducibleTarget) { throw }
      & $ReplaceReproducibleTarget $Target
      Remove-Item -LiteralPath $Target -Recurse -Force
      Write-Host "Replaced a verified reproducible Arcane build target without treating it as a native rollback."
    }
    if ($targetVerified) {
      Move-Item -LiteralPath $Target -Destination $Backup
      $hasRollback = $true
    }
  }
  try {
    Move-Item -LiteralPath $Stage -Destination $Target
    & $Verify $Target $RequireSigned
  } catch {
    $publicationFailure = $_
    if ($hasRollback -and (Test-Path -LiteralPath $Backup)) {
      try {
        Restore-ArcanePublicationBackup -Target $Target -Backup $Backup -Verify $Verify -RequireSigned $RequireSigned
      } catch {
        throw "The new Arcane publication failed and its rollback could not be restored; all recoverable trees were preserved. Publication: $($publicationFailure.Exception.Message) Rollback: $($_.Exception.Message)"
      }
    } elseif (Test-Path -LiteralPath $Target) {
      Remove-Item -LiteralPath $Target -Recurse -Force
    }
    throw $publicationFailure
  }
  if (Test-Path -LiteralPath $Backup) {
    Remove-Item -LiteralPath $Backup -Recurse -Force
  }
}
# ARCANE_PUBLICATION_HELPERS_END

$root = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $root 'dist'
$target = Join-Path $distRoot 'nt'
$stage = Join-Path $distRoot '.nt.stage'
$backup = Join-Path $distRoot '.nt.backup'
$rejected = "$target.rejected"
$partialRollback = "$backup.partial"
$lockPath = Join-Path $distRoot '.windows.publish.lock'
$legacyStage = Join-Path $distRoot '.windows.stage'
$legacyBackup = Join-Path $distRoot '.windows.backup'
$legacyRejected = Join-Path $distRoot 'windows.rejected'
$legacyPartialRollback = "$legacyBackup.partial"
$pkg = Join-Path $root 'node_modules\@yao-pkg\pkg\lib-es5\bin.js'
$runtime = Join-Path $root 'runtime\arcane-core.cjs'
$generatedApp = Join-Path $distRoot 'app'
$generatedBundle = Join-Path $distRoot 'arcane-bundle.json'
$generatedApps = Join-Path $distRoot 'apps'

$expectedParent = [IO.Path]::GetFullPath($distRoot).TrimEnd('\')
foreach ($candidate in @($target, $stage, $backup, $rejected, $partialRollback, $lockPath, $legacyStage, $legacyBackup, $legacyRejected, $legacyPartialRollback)) {
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
  if ($signingPolicy -eq '0') { throw 'Production Microsoft NT distribution conflicts with ARCANE_REQUIRE_SIGNED_RELEASE=0.' }
  $requiredSigningPolicy = '1'
  $requireSignedRelease = $true
  $releaseFlavor = 'PRODUCTION SIGNED'
}

function Assert-WindowsDistribution([string]$ReleaseRoot, [bool]$RequireSigned) {
  & node (Join-Path $root 'tools\verify-built-release.mjs') $ReleaseRoot
  if ($LASTEXITCODE -ne 0) { throw "Microsoft NT distribution exact verification failed for $ReleaseRoot." }
  $bundle = Get-Content -Raw -LiteralPath (Join-Path $ReleaseRoot 'arcane-bundle.json') | ConvertFrom-Json
  $contentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $ReleaseRoot 'arcane-machine-content.json')).Hash.ToLowerInvariant()
  $binding = "ARCANE-MACHINE-BINDING|1|$($bundle.version)|$contentHash"
  & (Join-Path $root 'tools\verify-windows-release-security.ps1') -ReleaseRoot $ReleaseRoot -ExpectedBinding $binding -RequireSigned:$RequireSigned
}

$verifyDistribution = {
  param([string]$Path, [bool]$RequireSigned)
  Assert-WindowsDistribution -ReleaseRoot $Path -RequireSigned $RequireSigned
}

function Assert-ReproducibleUnsignedDistribution([string]$ReleaseRoot) {
  & node (Join-Path $root 'tools\verify-built-release.mjs') $ReleaseRoot
  if ($LASTEXITCODE -ne 0) { throw 'The existing Microsoft NT build is not an exact reproducible Arcane distribution.' }
  $bundle = Get-Content -Raw -LiteralPath (Join-Path $ReleaseRoot 'arcane-bundle.json') | ConvertFrom-Json
  $contentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $ReleaseRoot 'arcane-machine-content.json')).Hash.ToLowerInvariant()
  & node (Join-Path $root 'tools\verify-content-bindings.mjs') machine $ReleaseRoot ([string]$bundle.version) $contentHash
  if ($LASTEXITCODE -ne 0) { throw 'The existing Microsoft NT build does not retain its exact native content binding.' }
  $executables = @(Get-ChildItem -LiteralPath $ReleaseRoot -Recurse -File -Filter '*.exe')
  if (-not $executables.Count) { throw 'The existing Microsoft NT build contains no executables.' }
  $nonLocal = @($executables | Where-Object { (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status -ne 'NotSigned' })
  if ($nonLocal.Count) { throw 'Only a complete unsigned reproducible build output may bypass native rollback migration.' }
}

$replaceReproducibleDistribution = {
  param([string]$Path)
  Assert-ReproducibleUnsignedDistribution -ReleaseRoot $Path
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$lockStream = $null
try {
  try {
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    throw 'Another Arcane Microsoft NT distribution build is already publishing in this workspace.'
  }
  $legacyPublicationState = @($legacyStage, $legacyBackup, $legacyRejected, $legacyPartialRollback) |
    Where-Object { Test-Path -LiteralPath $_ }
  if ($legacyPublicationState.Count) {
    throw "Arcane found unresolved legacy Microsoft NT publication state: $($legacyPublicationState -join ', '). Finish recovery with the pre-cutover builder or review the preserved paths before building dist\nt."
  }
  [Environment]::SetEnvironmentVariable('ARCANE_REQUIRE_SIGNED_RELEASE', $requiredSigningPolicy, 'Process')
  Write-Host "Arcane Microsoft NT distribution flavor: $releaseFlavor."

  Recover-ArcanePublication -Target $target -Stage $stage -Backup $backup -Verify $verifyDistribution -RequireSigned $requireSignedRelease

  if ($requireSignedRelease -and [string]::IsNullOrWhiteSpace([string]$env:ARCANE_SIGNING_CERT_THUMBPRINT)) {
    throw 'Production Microsoft NT distribution requires ARCANE_SIGNING_CERT_THUMBPRINT. Use the explicit unsigned-local-test build only for local verification.'
  }
  if ($requireSignedRelease -and [string]::IsNullOrWhiteSpace([string]$env:ARCANE_TIMESTAMP_SERVER)) {
    throw 'Production Microsoft NT distribution requires ARCANE_TIMESTAMP_SERVER.'
  }
  $configuredSigningThumbprint = ([string]$env:ARCANE_SIGNING_CERT_THUMBPRINT).Replace(' ', '').ToUpperInvariant()
  $configuredExpectedPublisher = ([string]$env:ARCANE_EXPECTED_PUBLISHER_THUMBPRINT).Replace(' ', '').ToUpperInvariant()
  if ($requireSignedRelease -and [string]::IsNullOrWhiteSpace($configuredExpectedPublisher)) {
    throw 'Production Microsoft NT distribution requires ARCANE_EXPECTED_PUBLISHER_THUMBPRINT.'
  }
  if ($requireSignedRelease -and $configuredSigningThumbprint -cne $configuredExpectedPublisher) {
    throw 'ARCANE_SIGNING_CERT_THUMBPRINT must match the independent ARCANE_EXPECTED_PUBLISHER_THUMBPRINT trust anchor.'
  }
  if (-not $requireSignedRelease -and $configuredExpectedPublisher) {
    throw 'Unsigned local-test builds conflict with ARCANE_EXPECTED_PUBLISHER_THUMBPRINT.'
  }

  if (-not (Test-Path -LiteralPath $pkg -PathType Leaf)) { throw 'The pinned pkg JavaScript entry point is missing. Run npm ci first.' }
  if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { throw 'The generated Arcane Core is missing. Run npm run build first.' }
  if (-not (Test-Path -LiteralPath $generatedApp -PathType Container) -or -not (Test-Path -LiteralPath $generatedBundle -PathType Leaf)) {
    throw 'The generated Arcane application payload is missing. Run npm run build first.'
  }

  # Target packages are part of the machine authenticity root, so the unified build
  # must finish them before it snapshots dist/apps into the staged release.
  $appBuildArguments = @((Join-Path $root 'tools\build-app.mjs'), '--all', '--platform=windows')
  if ($AllowUnsignedLocalRelease) { $appBuildArguments += '--allow-unsigned-local-release' }
  & node @appBuildArguments
  if ($LASTEXITCODE -ne 0) { throw 'Building the bound Microsoft NT application targets failed.' }
  if (-not (Test-Path -LiteralPath (Join-Path $generatedApps 'catalog.json') -PathType Leaf)) { throw 'The verified Microsoft NT app projection is missing.' }

  New-Item -ItemType Directory -Path (Join-Path $stage 'bin') -Force | Out-Null
  Copy-Item -LiteralPath $generatedApp -Destination (Join-Path $stage 'app') -Recurse
  Copy-Item -LiteralPath $generatedApps -Destination (Join-Path $stage 'apps') -Recurse
  Copy-Item -LiteralPath $generatedBundle -Destination (Join-Path $stage 'arcane-bundle.json')

  & node $pkg $runtime '--targets' 'node22-win-x64' '--output' (Join-Path $stage 'bin\ArcaneCore.exe')
  if ($LASTEXITCODE -ne 0) { throw "Packaging ArcaneCore.exe failed with exit code $LASTEXITCODE." }

  & (Join-Path $root 'tools\build-windows-webview2.ps1') -Dist $stage
  if ($LASTEXITCODE -ne 0) { throw "Building the bound WebView2 hosts failed with exit code $LASTEXITCODE." }

  & node (Join-Path $root 'tools\write-release-manifest.mjs') windows $stage
  if ($LASTEXITCODE -ne 0) { throw 'Writing the outer Microsoft NT release manifest failed.' }

  Publish-VerifiedArcaneDirectory -Stage $stage -Target $target -Backup $backup -Verify $verifyDistribution -RequireSigned $requireSignedRelease -ReplaceReproducibleTarget $replaceReproducibleDistribution
  Write-Host "Published $releaseFlavor bound Microsoft NT distribution to $target"
} finally {
  if (Test-Path -LiteralPath $stage) {
    try { Remove-Item -LiteralPath $stage -Recurse -Force }
    catch { Write-Warning "Deferred cleanup of $stage until the next locked build: $($_.Exception.Message)" }
  }
  [Environment]::SetEnvironmentVariable('ARCANE_REQUIRE_SIGNED_RELEASE', $previousSigningPolicy, 'Process')
  if ($lockStream) { $lockStream.Dispose() }
}
