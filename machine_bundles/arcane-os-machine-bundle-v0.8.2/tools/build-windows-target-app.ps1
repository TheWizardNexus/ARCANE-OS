param(
  [Parameter(Mandatory=$true)][string]$AppId,
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$targetsRoot = [IO.Path]::GetFullPath((Join-Path $root 'dist\targets')).TrimEnd('\')
$sourcePath = [IO.Path]::GetFullPath($Source)
$targetPath = [IO.Path]::GetFullPath($Target)
if ($AppId.Length -gt 64 -or $AppId -cnotmatch '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$') { throw 'Invalid Arcane target app id.' }
foreach ($candidate in @($sourcePath, $targetPath)) {
  if (-not $candidate.StartsWith($targetsRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to build an app outside dist\targets.'
  }
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw 'The isolated source app package is missing.' }

$stage = Join-Path $targetsRoot ".$AppId.native-stage-$PID"
$backup = Join-Path $targetsRoot ".$AppId.native-backup-$PID"
$cache = Join-Path $root '.cache\webview2'
$bundle = Get-Content -Raw -LiteralPath (Join-Path $root 'arcane-bundle.json') | ConvertFrom-Json
$version = [string]$bundle.build.webview2SdkVersion
$expectedPackageHash = ([string]$bundle.build.webview2SdkSha256).ToLowerInvariant()
$package = Join-Path $cache "microsoft.web.webview2.$version.nupkg"
$sdkRoot = Join-Path $cache ".app-build-$version-$PID"
$pkg = Join-Path $root 'node_modules\.bin\pkg.cmd'
$hostSource = Join-Path $root 'src\hosts\windows\ArcaneHost.cs'
$pipeGuardSource = Join-Path $root 'src\hosts\windows\ArcanePipeGuard.cs'
$icon = Join-Path $root 'assets\arcane-sigil.ico'

foreach ($candidate in @($stage, $backup, $sdkRoot)) {
  if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Recurse -Force }
}
if (-not (Test-Path -LiteralPath $package)) { throw "Pinned WebView2 SDK package is missing: $package" }
$actualPackageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant()
if ($actualPackageHash -ne $expectedPackageHash) { throw 'The pinned WebView2 SDK package failed SHA-256 verification.' }

$movedExisting = $false
try {
  Copy-Item -LiteralPath $sourcePath -Destination $stage -Recurse
  $appManifest = Get-Content -Raw -LiteralPath (Join-Path $stage 'arcane-app-package.json') | ConvertFrom-Json
  if ([string]$appManifest.app.id -ne $AppId) { throw 'Isolated app manifest identity mismatch.' }
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
      Where-Object { $_.FullName -notmatch '\\ref\\' } |
      Sort-Object FullName |
      Select-Object -First 1
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

  $candidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
  )
  $csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $csc) { throw 'The .NET Framework C# compiler was not found.' }
  function Escape-CSharp([string]$value) { return $value.Replace('\','\\').Replace('"','\"').Replace("`r",'').Replace("`n",' ') }
  $targetInfo = Join-Path $sdkRoot 'ArcaneTarget.cs'
  $assemblyInfo = Join-Path $sdkRoot 'ArcaneTargetAssemblyInfo.cs'
  $numericVersion = "$($bundle.version).0"
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
"@
  $utf8 = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($targetInfo, $targetSource, $utf8)
  [IO.File]::WriteAllText($assemblyInfo, $assemblySource, $utf8)
  $launcherExe = "ArcaneApp-$AppId.exe"
  $arguments = @(
    '/nologo','/target:winexe','/platform:x64','/optimize+','/debug-','/warn:4',
    '/define:ARCANE_TARGET_APP',"/win32icon:$icon","/out:$(Join-Path $stage $launcherExe)",
    '/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll',
    "/reference:$coreDll","/reference:$formsDll",$hostSource,$targetInfo,$assemblyInfo
  )
  & $csc $arguments
  if ($LASTEXITCODE -ne 0) { throw "Target host compilation failed with exit code $LASTEXITCODE." }

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

  $signatureStatus = 'NotSigned'
  $requireSignedRelease = $env:ARCANE_REQUIRE_SIGNED_RELEASE -eq '1'
  $timestampServer = ([string]$env:ARCANE_TIMESTAMP_SERVER).Trim()
  $signingThumbprint = ([string]$env:ARCANE_SIGNING_CERT_THUMBPRINT).Replace(' ', '')
  if ($requireSignedRelease -and -not $timestampServer) {
    throw 'A production-signed target app requires ARCANE_TIMESTAMP_SERVER so signatures remain verifiable after certificate expiry.'
  }
  if ($signingThumbprint) {
    $certificate = Get-ChildItem -Path Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert |
      Where-Object { $_.Thumbprint -eq $signingThumbprint } | Select-Object -First 1
    if (-not $certificate -or -not $certificate.HasPrivateKey) { throw 'The configured code-signing certificate is unavailable.' }
    foreach ($fileName in @($launcherExe,'ArcaneCore.exe',$pipeGuardExe)) {
      $signingArguments = @{FilePath=(Join-Path $stage $fileName);Certificate=$certificate;HashAlgorithm='SHA256'}
      if ($timestampServer) { $signingArguments.TimestampServer=$timestampServer }
      $signature = Set-AuthenticodeSignature @signingArguments
      if ($signature.Status -ne 'Valid') { throw "Authenticode signing failed for ${fileName}: $($signature.StatusMessage)" }
      if ($requireSignedRelease -and -not $signature.TimeStamperCertificate) { throw "Authenticode timestamping failed for ${fileName}." }
    }
    $signatureStatus = 'Valid'
  } elseif ($requireSignedRelease) {
    throw 'A signed target app is required, but ARCANE_SIGNING_CERT_THUMBPRINT was not provided.'
  } else {
    Write-Warning 'This local target app is unsigned; distribution builds must provide a code-signing certificate.'
  }

  & (Join-Path $root 'tools\verify-windows-host-dispatch.ps1') -Dist $stage -Files @($launcherExe)
  node (Join-Path $root 'tools\smoke-test-windows-pipe-guard.mjs') (Join-Path $stage $pipeGuardExe)
  if ($LASTEXITCODE -ne 0) { throw 'ArcanePipeGuard kernel peer-identity smoke test failed.' }
  $launcherBatch = "@echo off`r`nstart `"`" `"%~dp0$launcherExe`" %*`r`n"
  [IO.File]::WriteAllText((Join-Path $stage "start-$AppId.bat"), $launcherBatch, [Text.Encoding]::ASCII)
  node (Join-Path $root 'tools\finalize-app-package.mjs') $stage $AppId $launcherExe $signatureStatus
  if ($LASTEXITCODE -ne 0) { throw 'Finalizing the native app inventory failed.' }

  if (Test-Path -LiteralPath $targetPath) { Move-Item -LiteralPath $targetPath -Destination $backup; $movedExisting = $true }
  Move-Item -LiteralPath $stage -Destination $targetPath
  if ($movedExisting -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Recurse -Force }
  Write-Host "Built runnable Arcane app $AppId at $targetPath"
} catch {
  if (-not (Test-Path -LiteralPath $targetPath) -and $movedExisting -and (Test-Path -LiteralPath $backup)) {
    Move-Item -LiteralPath $backup -Destination $targetPath
  }
  throw
} finally {
  foreach ($candidate in @($stage, $sdkRoot)) { if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Recurse -Force } }
}
