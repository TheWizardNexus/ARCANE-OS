param(
  [Parameter(Mandatory=$true)][string]$AppId,
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target
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
$targetsRoot = [IO.Path]::GetFullPath((Join-Path $root 'dist\targets')).TrimEnd('\')
$sourcePath = [IO.Path]::GetFullPath($Source)
$targetPath = [IO.Path]::GetFullPath($Target)
if ($AppId.Length -gt 64 -or $AppId -cnotmatch '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' -or $AppId -cmatch '^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$') {
  throw 'Invalid or Windows-reserved Arcane target app id.'
}
foreach ($candidate in @($sourcePath, $targetPath)) {
  if (-not $candidate.StartsWith($targetsRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to build an app outside dist\targets.' }
}
$expectedTargetPath = [IO.Path]::GetFullPath((Join-Path $targetsRoot $AppId))
if ($targetPath -cne $expectedTargetPath) { throw 'The native Arcane app must publish to its canonical dist\targets app directory.' }
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw 'The isolated source app package is missing.' }

$stage = Join-Path $targetsRoot ".$AppId.native-stage"
$backup = Join-Path $targetsRoot ".$AppId.native-backup"
$rejected = "$targetPath.rejected"
$partialRollback = "$backup.partial"
$lockPath = Join-Path $targetsRoot ".$AppId.native-publish.lock"
$cache = Join-Path $root '.cache\webview2'
$bundle = Get-Content -Raw -LiteralPath (Join-Path $root 'arcane-bundle.json') | ConvertFrom-Json
$sdkVersion = [string]$bundle.build.webview2SdkVersion
$expectedPackageHash = ([string]$bundle.build.webview2SdkSha256).ToLowerInvariant()
$package = Join-Path $cache "microsoft.web.webview2.$sdkVersion.nupkg"
$sdkRoot = Join-Path $cache ".app-build-$sdkVersion-$PID"
$pkg = Join-Path $root 'node_modules\.bin\pkg.cmd'
$hostSource = Join-Path $root 'src\hosts\windows\ArcaneHost.cs'
$pipeGuardSource = Join-Path $root 'src\hosts\windows\ArcanePipeGuard.cs'
$icon = Join-Path $root 'assets\arcane-sigil.ico'

foreach ($candidate in @($stage, $backup, $rejected, $partialRollback, $lockPath)) {
  $resolved = [IO.Path]::GetFullPath($candidate)
  $resolvedParent = [IO.Path]::GetFullPath((Split-Path -Parent $resolved)).TrimEnd('\')
  if ($resolvedParent -ne $targetsRoot) { throw 'Refusing to publish target app state outside dist\targets.' }
}
$signingPolicy = ([string]$env:ARCANE_REQUIRE_SIGNED_RELEASE).Trim()
if ($signingPolicy -and $signingPolicy -notin @('0', '1')) { throw 'ARCANE_REQUIRE_SIGNED_RELEASE must be exactly 0 or 1 when provided.' }
$requireSignedRelease = $env:ARCANE_REQUIRE_SIGNED_RELEASE -eq '1'
if (-not $signingPolicy) { $requireSignedRelease = $true }
$timestampServer = ([string]$env:ARCANE_TIMESTAMP_SERVER).Trim()
$signingThumbprint = ([string]$env:ARCANE_SIGNING_CERT_THUMBPRINT).Replace(' ', '').ToUpperInvariant()
$expectedPublisherThumbprint = ([string]$env:ARCANE_EXPECTED_PUBLISHER_THUMBPRINT).Replace(' ', '').ToUpperInvariant()
if ($expectedPublisherThumbprint -and $expectedPublisherThumbprint -cnotmatch '^[A-F0-9]{40,128}$') { throw 'ARCANE_EXPECTED_PUBLISHER_THUMBPRINT must be a 40-128 character hexadecimal certificate thumbprint.' }
$certificate = $null

$targetFlavor = if ($requireSignedRelease) { 'PRODUCTION SIGNED' } else { 'UNSIGNED LOCAL-TEST ALLOWED' }

function Assert-WindowsTargetPackage(
  [string]$PackageRoot,
  [bool]$RequireSigned,
  [string]$ExpectedPublisherThumbprint = ([string]$env:ARCANE_EXPECTED_PUBLISHER_THUMBPRINT)
) {
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $PackageRoot 'arcane-app-package.json') | ConvertFrom-Json
  if ([string]$manifest.app.id -cne $AppId) { throw "Published Arcane app identity mismatch at $PackageRoot." }
  if ([string]$manifest.bundleVersion -cne [string]$bundle.version) { throw "Published Arcane app version mismatch at $PackageRoot." }
  $launcher = "ArcaneApp-$AppId.exe"
  if ([string]$manifest.native.launcher -cne $launcher) { throw "Published Arcane app launcher mismatch at $PackageRoot." }
  $contentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PackageRoot 'arcane-app-content.json')).Hash.ToLowerInvariant()
  $binding = "ARCANE-TARGET-BINDING|1|$AppId|$contentHash"
  & (Join-Path $root 'tools\verify-windows-release-security.ps1') -ReleaseRoot $PackageRoot -TargetAppId $AppId -ExpectedBinding $binding -ExpectedPublisherThumbprint $ExpectedPublisherThumbprint -RequireSigned:$RequireSigned
}

function Assert-ReproduciblePortableTarget([string]$PackageRoot) {
  $rootItem = Get-Item -LiteralPath $PackageRoot -Force
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The existing portable Arcane target root must be a real directory.'
  }
  $manifestPath = Join-Path $PackageRoot 'arcane-app-package.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The existing target is not a portable Arcane package.' }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $manifestFields = @($manifest.PSObject.Properties.Name)
  $expectedFields = @('schemaVersion', 'protocolVersion', 'bundleVersion', 'app', 'files')
  if ($manifestFields.Count -ne $expectedFields.Count -or @($manifestFields | Where-Object { $_ -cnotin $expectedFields }).Count) {
    throw 'Only the exact portable Arcane package shape may be replaced without a native rollback.'
  }
  if ([string]$manifest.app.id -cne $AppId -or [string]$manifest.bundleVersion -cne [string]$bundle.version) {
    throw 'Portable Arcane package identity or version mismatch.'
  }
  if ([int]$manifest.schemaVersion -ne 1 -or [string]$manifest.protocolVersion -cne [string]$bundle.protocolVersion -or [string]$manifest.app.type -cne 'app') {
    throw 'Portable Arcane package schema, protocol, or app type mismatch.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot 'runtime\arcane-core.cjs') -PathType Leaf)) {
    throw 'Portable Arcane package is missing its expected source runtime.'
  }

  $expected = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  foreach ($entry in @($manifest.files)) {
    $entryFields = @($entry.PSObject.Properties.Name)
    if ($entryFields.Count -ne 3 -or @($entryFields | Where-Object { $_ -cnotin @('path', 'size', 'sha256') }).Count) {
      throw 'Portable Arcane package contains a malformed inventory entry.'
    }
    $relative = [string]$entry.path
    if (-not $relative -or $relative.Contains('\') -or $relative.StartsWith('/') -or $relative.Split('/') -contains '..') {
      throw 'Portable Arcane package contains an unsafe inventory path.'
    }
    if ($relative -cmatch '(?:^|/)arcane-app-content\.json$' -or $relative -cmatch '\.exe$') {
      throw 'Portable Arcane package contains native release material.'
    }
    if ($expected.ContainsKey($relative)) { throw 'Portable Arcane package contains duplicate inventory paths.' }
    $expected.Add($relative, $entry)
  }
  if (-not $expected.ContainsKey('runtime/arcane-core.cjs')) { throw 'Portable Arcane inventory omits its expected source runtime.' }

  $packageRootFull = [IO.Path]::GetFullPath($PackageRoot).TrimEnd('\')
  $actual = [Collections.Generic.Dictionary[string,IO.FileInfo]]::new([StringComparer]::Ordinal)
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($packageRootFull)
  while ($pending.Count) {
    $directory = $pending.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Portable Arcane package contains a reparse point.' }
      if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
      $full = [IO.Path]::GetFullPath($item.FullName)
      if (-not $full.StartsWith($packageRootFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Portable Arcane inventory escaped its package root.' }
      $relative = $full.Substring($packageRootFull.Length + 1).Replace('\', '/')
      if ($relative -ceq 'arcane-app-package.json') { continue }
      if ($actual.ContainsKey($relative)) { throw 'Portable Arcane package contains duplicate filesystem paths.' }
      $actual.Add($relative, $item)
    }
  }
  if ($actual.Count -ne $expected.Count) { throw 'Portable Arcane package inventory is not exact.' }
  foreach ($pair in $expected.GetEnumerator()) {
    if (-not $actual.ContainsKey($pair.Key)) { throw "Portable Arcane package is missing $($pair.Key)." }
    $file = $actual[$pair.Key]
    if ([int64]$pair.Value.size -ne [int64]$file.Length) { throw "Portable Arcane package size mismatch for $($pair.Key)." }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    if ([string]$pair.Value.sha256 -cne $hash) { throw "Portable Arcane package hash mismatch for $($pair.Key)." }
  }
}

$verifyTargetPackage = {
  param([string]$Path, [bool]$RequireSigned)
  Assert-WindowsTargetPackage -PackageRoot $Path -RequireSigned $RequireSigned
}
function Assert-ReproducibleUnsignedNativeTarget([string]$PackageRoot) {
  Assert-WindowsTargetPackage -PackageRoot $PackageRoot -RequireSigned $false -ExpectedPublisherThumbprint ''
}

$replaceReproducibleTarget = {
  param([string]$Path)
  $portableFailure = $null
  try {
    Assert-ReproduciblePortableTarget -PackageRoot $Path
    return
  } catch {
    $portableFailure = $_.Exception.Message
  }
  try {
    Assert-ReproducibleUnsignedNativeTarget -PackageRoot $Path
    return
  } catch {
    throw "The existing target is neither an exact portable package nor an exact unsigned native build. Portable: $portableFailure Native: $($_.Exception.Message)"
  }
}

function Sign-ArcaneFile([string]$fileName) {
  if (-not $certificate) { return }
  $arguments = @{FilePath=(Join-Path $stage $fileName);Certificate=$certificate;HashAlgorithm='SHA256'}
  if ($timestampServer) { $arguments.TimestampServer=$timestampServer }
  $signature = Set-AuthenticodeSignature @arguments
  if ($signature.Status -ne 'Valid') { throw "Authenticode signing failed for ${fileName}: $($signature.StatusMessage)" }
  if (-not $signature.TimeStamperCertificate) { throw "Authenticode timestamping failed for ${fileName}." }
}

$lockStream = $null
try {
  try {
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    throw "Another Arcane target app build is already publishing $AppId."
  }
  Write-Host "Arcane target app $AppId build flavor: $targetFlavor."
  Recover-ArcanePublication -Target $targetPath -Stage $stage -Backup $backup -Verify $verifyTargetPackage -RequireSigned $requireSignedRelease

  if ($signingThumbprint) {
    if (-not $timestampServer) { throw 'ARCANE_TIMESTAMP_SERVER is required whenever an Arcane signing certificate is configured.' }
    $certificate = Get-ChildItem -Path Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert |
      Where-Object { $_.Thumbprint -eq $signingThumbprint } | Select-Object -First 1
    if (-not $certificate -or -not $certificate.HasPrivateKey) { throw 'The configured code-signing certificate is unavailable.' }
    if (-not $expectedPublisherThumbprint) { throw 'Signed Arcane builds require the independent ARCANE_EXPECTED_PUBLISHER_THUMBPRINT trust anchor.' }
    if (([string]$certificate.Thumbprint).Replace(' ', '').ToUpperInvariant() -cne $expectedPublisherThumbprint) { throw 'The Arcane signing certificate does not match ARCANE_EXPECTED_PUBLISHER_THUMBPRINT.' }
  } elseif ($requireSignedRelease) {
    throw 'A production-signed target app is required by default, but ARCANE_SIGNING_CERT_THUMBPRINT was not provided.'
  } elseif ($expectedPublisherThumbprint) {
    throw 'Unsigned local-test builds conflict with ARCANE_EXPECTED_PUBLISHER_THUMBPRINT.'
  }
  $publisherBinding = if ($certificate) {
    'ARCANE-PUBLISHER|1|' + $expectedPublisherThumbprint
  } else {
    'ARCANE-PUBLISHER|1|UNSIGNED-LOCAL-TEST'
  }

  if (Test-Path -LiteralPath $sdkRoot) { Remove-Item -LiteralPath $sdkRoot -Recurse -Force }
  if (-not (Test-Path -LiteralPath $pkg -PathType Leaf)) { throw 'The pinned pkg build tool is missing. Run npm ci first.' }
  New-Item -ItemType Directory -Path $cache -Force | Out-Null
  if (-not (Test-Path -LiteralPath $package -PathType Leaf)) {
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
    Write-Host "Downloading pinned WebView2 SDK $sdkVersion for target app $AppId..."
    Invoke-WebRequest -Uri $url -OutFile $package -UseBasicParsing
  }
  $actualPackageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant()
  if ($actualPackageHash -ne $expectedPackageHash) { throw 'The pinned WebView2 SDK package failed SHA-256 verification.' }

  Copy-Item -LiteralPath $sourcePath -Destination $stage -Recurse
  $appManifest = Get-Content -Raw -LiteralPath (Join-Path $stage 'arcane-app-package.json') | ConvertFrom-Json
  if ([string]$appManifest.app.id -cne $AppId) { throw 'Isolated app manifest identity mismatch.' }
  if ([string]$appManifest.bundleVersion -cne [string]$bundle.version) { throw 'Isolated app bundle version mismatch.' }
  $displayName = [string]$appManifest.app.displayName
  $allowMicrophone = @($appManifest.app.capabilities) -contains 'media.microphone'
  $allowedNavigationPaths = @($appManifest.app.security.navigationEntries)
  if ($allowedNavigationPaths.Count -eq 0) { throw 'The isolated app manifest has no secured navigation entries.' }
  $navigationSeen = @{}
  $navigationPattern = '^/' + [Regex]::Escape($AppId) + '/[a-zA-Z0-9._-]+\.html$'
  foreach ($navigationPathValue in $allowedNavigationPaths) {
    if ($null -eq $navigationPathValue) { throw 'The isolated app manifest contains an invalid navigation entry.' }
    $navigationPath = [string]$navigationPathValue
    if ($navigationPath -cnotmatch $navigationPattern) { throw "Unsafe target navigation entry: $navigationPath" }
    if ($navigationSeen.ContainsKey($navigationPath)) { throw "Duplicate target navigation entry: $navigationPath" }
    $navigationSeen[$navigationPath] = $true
    $navigationFile = Join-Path (Join-Path $stage 'app') $navigationPath.Substring(1).Replace('/', '\')
    if (-not (Test-Path -LiteralPath $navigationFile -PathType Leaf)) { throw "Target navigation entry is missing: $navigationPath" }
  }
  if (-not $navigationSeen.ContainsKey("/$AppId/index.html")) { throw 'The target navigation allowlist omits its launch entry.' }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($package, $sdkRoot)
  function Find-SdkFile([string]$name, [string]$preferred) {
    $preferredPath = Join-Path $sdkRoot $preferred
    if (Test-Path -LiteralPath $preferredPath) { return $preferredPath }
    $match = Get-ChildItem -LiteralPath $sdkRoot -Recurse -File -Filter $name |
      Where-Object { $_.FullName -notmatch '\\ref\\' } | Sort-Object FullName | Select-Object -First 1
    if (-not $match) { throw "The WebView2 SDK does not contain $name." }
    return $match.FullName
  }
  $coreDll = Find-SdkFile 'Microsoft.Web.WebView2.Core.dll' 'lib\net462\Microsoft.Web.WebView2.Core.dll'
  $formsDll = Find-SdkFile 'Microsoft.Web.WebView2.WinForms.dll' 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
  $loaderDll = Find-SdkFile 'WebView2Loader.dll' 'runtimes\win-x64\native\WebView2Loader.dll'
  Copy-Item -LiteralPath $coreDll -Destination (Join-Path $stage 'Microsoft.Web.WebView2.Core.dll') -Force
  Copy-Item -LiteralPath $formsDll -Destination (Join-Path $stage 'Microsoft.Web.WebView2.WinForms.dll') -Force
  Copy-Item -LiteralPath $loaderDll -Destination (Join-Path $stage 'WebView2Loader.dll') -Force

  & $pkg (Join-Path $stage 'runtime\arcane-core.cjs') '--targets' 'node22-win-x64' '--output' (Join-Path $stage 'ArcaneCore.exe')
  if ($LASTEXITCODE -ne 0) { throw "Packaging target ArcaneCore.exe failed with exit code $LASTEXITCODE." }
  $runtimeSource = Join-Path $stage 'runtime'
  if (Test-Path -LiteralPath $runtimeSource) { Remove-Item -LiteralPath $runtimeSource -Recurse -Force }
  $mutableLauncher = Join-Path $stage "start-$AppId.bat"
  if (Test-Path -LiteralPath $mutableLauncher) { Remove-Item -LiteralPath $mutableLauncher -Force }

  $candidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
  )
  $csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $csc) { throw 'The .NET Framework C# compiler was not found.' }
  function Escape-CSharp([string]$value) { return $value.Replace('\','\\').Replace('"','\"').Replace("`r",'').Replace("`n",' ') }
  $numericVersion = "$($bundle.version).0"
  if ($numericVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Arcane bundle version cannot be embedded in a Windows assembly.' }
  $utf8 = New-Object Text.UTF8Encoding($false)

  $pipeGuardAssemblyInfo = Join-Path $sdkRoot 'ArcanePipeGuardAssemblyInfo.cs'
  $pipeGuardAssemblySource = @"
using System.Reflection;
[assembly: AssemblyTitle("Arcane Pipe Guard")]
[assembly: AssemblyProduct("Arcane OS")]
[assembly: AssemblyCompany("Arcane OS")]
[assembly: AssemblyDescription("Kernel-bound Windows named-pipe peer verifier")]
[assembly: AssemblyVersion("$numericVersion")]
[assembly: AssemblyFileVersion("$numericVersion")]
[assembly: AssemblyInformationalVersion("$($bundle.version)")]
"@
  [IO.File]::WriteAllText($pipeGuardAssemblyInfo, $pipeGuardAssemblySource, $utf8)
  $pipeGuardExe = 'ArcanePipeGuard.exe'
  $pipeGuardArguments = @(
    '/nologo','/target:exe','/platform:x64','/optimize+','/debug-','/warn:4',
    "/win32icon:$icon","/out:$(Join-Path $stage $pipeGuardExe)",
    '/reference:System.dll','/reference:System.Core.dll',$pipeGuardSource,$pipeGuardAssemblyInfo
  )
  & $csc $pipeGuardArguments
  if ($LASTEXITCODE -ne 0) { throw "ArcanePipeGuard.exe compilation failed with exit code $LASTEXITCODE." }

  Sign-ArcaneFile 'ArcaneCore.exe'
  Sign-ArcaneFile $pipeGuardExe
  if (-not $certificate) { Write-Warning 'This local target app is unsigned; distribution builds must provide a code-signing certificate.' }

  $launcherExe = "ArcaneApp-$AppId.exe"
  $contentOutput = & node (Join-Path $root 'tools\write-app-content-manifest.mjs') $stage $AppId $launcherExe
  if ($LASTEXITCODE -ne 0) { throw 'Writing the bound target content manifest failed.' }
  $content = ($contentOutput | Select-Object -Last 1) | ConvertFrom-Json
  $contentHash = ([string]$content.sha256).ToLowerInvariant()
  if ($contentHash -notmatch '^[a-f0-9]{64}$') { throw 'The target content manifest did not return a valid SHA-256 binding.' }
  $targetBinding = "ARCANE-TARGET-BINDING|1|$AppId|$contentHash"

  $targetInfo = Join-Path $sdkRoot 'ArcaneTarget.cs'
  $assemblyInfo = Join-Path $sdkRoot 'ArcaneTargetAssemblyInfo.cs'
  $allowMicrophoneLiteral = if ($allowMicrophone) { 'true' } else { 'false' }
  $allowedNavigationSource = ($allowedNavigationPaths | ForEach-Object { '      "' + (Escape-CSharp ([string]$_)) + '"' }) -join ",`r`n"
  $targetSource = @"
namespace ArcaneOS {
  internal static class ArcaneTarget {
    internal const string AppMode = "$(Escape-CSharp $AppId)";
    internal const string ProductName = "$(Escape-CSharp $displayName)";
    internal const string AppId = "Arcane.OS.App.$(Escape-CSharp $AppId)";
    internal const bool AllowMicrophone = $allowMicrophoneLiteral;
    internal static readonly string[] AllowedNavigationPaths = new string[] {
$allowedNavigationSource
    };
  }
}
"@
  $assemblySource = @"
using System.Reflection;
[assembly: AssemblyTitle("$(Escape-CSharp $displayName)")]
[assembly: AssemblyProduct("Arcane OS")]
[assembly: AssemblyCompany("Arcane OS")]
[assembly: AssemblyDescription("Arcane OS isolated application host")]
[assembly: AssemblyVersion("$numericVersion")]
[assembly: AssemblyFileVersion("$numericVersion")]
[assembly: AssemblyInformationalVersion("$($bundle.version)")]
[assembly: AssemblyMetadata("ArcaneContentBinding", "$targetBinding")]
[assembly: AssemblyMetadata("ArcanePublisherBinding", "$publisherBinding")]
"@
  [IO.File]::WriteAllText($targetInfo, $targetSource, $utf8)
  [IO.File]::WriteAllText($assemblyInfo, $assemblySource, $utf8)
  $arguments = @(
    '/nologo','/target:winexe','/platform:x64','/optimize+','/debug-','/warn:4',
    '/define:ARCANE_TARGET_APP',"/win32icon:$icon","/out:$(Join-Path $stage $launcherExe)",
    '/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',
    "/reference:$coreDll","/reference:$formsDll",$hostSource,$targetInfo,$assemblyInfo
  )
  & $csc $arguments
  if ($LASTEXITCODE -ne 0) { throw "Target host compilation failed with exit code $LASTEXITCODE." }
  Sign-ArcaneFile $launcherExe

  & node (Join-Path $root 'tools\verify-content-bindings.mjs') target $stage $AppId $contentHash
  if ($LASTEXITCODE -ne 0) { throw 'The compiled target content binding verification failed.' }
  $powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  & $powershell '-NoLogo' '-NoProfile' '-NonInteractive' '-ExecutionPolicy' 'Bypass' '-File' (Join-Path $root 'tools\verify-windows-host-dispatch.ps1') '-Dist' $stage '-Files' $launcherExe
  if ($LASTEXITCODE -ne 0) { throw 'Target host COM dispatch verification failed.' }
  & node (Join-Path $root 'tools\smoke-test-windows-pipe-guard.mjs') (Join-Path $stage $pipeGuardExe)
  if ($LASTEXITCODE -ne 0) { throw 'ArcanePipeGuard kernel peer-identity smoke test failed.' }

  $signatureStatus = if ($certificate) { 'Valid' } else { 'NotSigned' }
  & node (Join-Path $root 'tools\finalize-app-package.mjs') $stage $AppId $launcherExe $signatureStatus
  if ($LASTEXITCODE -ne 0) { throw 'Finalizing the native app inventory failed.' }
  & (Join-Path $root 'tools\verify-windows-release-security.ps1') -ReleaseRoot $stage -TargetAppId $AppId -ExpectedBinding $targetBinding -RequireSigned:$requireSignedRelease

  Publish-VerifiedArcaneDirectory -Stage $stage -Target $targetPath -Backup $backup -Verify $verifyTargetPackage -RequireSigned $requireSignedRelease -ReplaceReproducibleTarget $replaceReproducibleTarget
  Write-Host "Published $targetFlavor bound Arcane app $AppId at $targetPath"
} finally {
  foreach ($candidate in @($stage, $sdkRoot)) {
    if (Test-Path -LiteralPath $candidate) {
      try { Remove-Item -LiteralPath $candidate -Recurse -Force }
      catch { Write-Warning "Deferred cleanup of $candidate until the next locked build: $($_.Exception.Message)" }
    }
  }
  if ($lockStream) { $lockStream.Dispose() }
}
