param(
  [string]$Dist
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Dist)) { $Dist = Join-Path $root 'dist\windows' }
$release = [IO.Path]::GetFullPath($Dist).TrimEnd('\')
$bin = Join-Path $release 'bin'
$source = Join-Path $root 'src\hosts\windows\ArcaneHost.cs'
$pipeGuardSource = Join-Path $root 'src\hosts\windows\ArcanePipeGuard.cs'
$icon = Join-Path $root 'assets\arcane-sigil.ico'
$cache = Join-Path $root '.cache\webview2'

foreach ($required in @(
  (Join-Path $release 'arcane-bundle.json'),
  (Join-Path $release 'app\provisioner\index.html'),
  (Join-Path $release 'app\shell\index.html'),
  (Join-Path $release 'apps\catalog.json'),
  (Join-Path $bin 'ArcaneCore.exe')
)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "The staged Windows release is incomplete: $required" }
}
New-Item -ItemType Directory -Path $cache -Force | Out-Null

$bundle = Get-Content -Raw -LiteralPath (Join-Path $release 'arcane-bundle.json') | ConvertFrom-Json
$sdkVersion = [string]$bundle.build.webview2SdkVersion
$expectedPackageHash = ([string]$bundle.build.webview2SdkSha256).ToLowerInvariant()
if (-not $sdkVersion -or $expectedPackageHash -notmatch '^[a-f0-9]{64}$') { throw 'arcane-bundle.json must pin the WebView2 SDK version and SHA-256.' }
$package = Join-Path $cache "microsoft.web.webview2.$sdkVersion.nupkg"
if (-not (Test-Path -LiteralPath $package -PathType Leaf)) {
  $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
  Write-Host "Downloading pinned WebView2 SDK $sdkVersion..."
  Invoke-WebRequest -Uri $url -OutFile $package -UseBasicParsing
}
$actualPackageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant()
if ($actualPackageHash -ne $expectedPackageHash) { throw "The cached WebView2 SDK package failed SHA-256 verification. Expected $expectedPackageHash but received $actualPackageHash." }
Write-Host "Using verified, pinned Microsoft.Web.WebView2 SDK $sdkVersion."
$packageRoot = Join-Path $cache ".build-$sdkVersion-$PID"
if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }

try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($package, $packageRoot)
  function Find-SdkFile([string]$name, [string]$preferred) {
    $preferredPath = Join-Path $packageRoot $preferred
    if (Test-Path -LiteralPath $preferredPath) { return $preferredPath }
    $match = Get-ChildItem -LiteralPath $packageRoot -Recurse -File -Filter $name |
      Where-Object { $_.FullName -notmatch '\\ref\\' } | Sort-Object FullName | Select-Object -First 1
    if (-not $match) { throw "The WebView2 SDK package does not contain $name." }
    return $match.FullName
  }
  $coreDll = Find-SdkFile 'Microsoft.Web.WebView2.Core.dll' 'lib\net462\Microsoft.Web.WebView2.Core.dll'
  $formsDll = Find-SdkFile 'Microsoft.Web.WebView2.WinForms.dll' 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
  $loaderDll = Find-SdkFile 'WebView2Loader.dll' 'runtimes\win-x64\native\WebView2Loader.dll'
  Copy-Item -LiteralPath $coreDll -Destination (Join-Path $bin 'Microsoft.Web.WebView2.Core.dll') -Force
  Copy-Item -LiteralPath $formsDll -Destination (Join-Path $bin 'Microsoft.Web.WebView2.WinForms.dll') -Force
  Copy-Item -LiteralPath $loaderDll -Destination (Join-Path $bin 'WebView2Loader.dll') -Force

  $candidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
  )
  $csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $csc) { throw 'The .NET Framework C# compiler was not found. Enable .NET Framework 4.x developer tools.' }
  $numericVersion = "$($bundle.version).0"
  if ($numericVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "Arcane version $($bundle.version) cannot be embedded in a Windows assembly." }
  $utf8 = New-Object Text.UTF8Encoding($false)

  $pipeGuardTarget = Join-Path $bin 'ArcanePipeGuard.exe'
  $pipeGuardAssemblyInfo = Join-Path $packageRoot '.ArcanePipeGuardAssemblyInfo.cs'
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
  $pipeGuardArguments = @(
    '/nologo','/target:exe','/platform:x64','/optimize+','/debug-','/warn:4',
    "/win32icon:$icon","/out:$pipeGuardTarget",'/reference:System.dll','/reference:System.Core.dll',$pipeGuardSource,$pipeGuardAssemblyInfo
  )
  & $csc $pipeGuardArguments
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pipeGuardTarget -PathType Leaf)) { throw 'ArcanePipeGuard.exe compilation failed.' }

  $requireSignedRelease = $env:ARCANE_REQUIRE_SIGNED_RELEASE -eq '1'
  $timestampServer = ([string]$env:ARCANE_TIMESTAMP_SERVER).Trim()
  $signingThumbprint = ([string]$env:ARCANE_SIGNING_CERT_THUMBPRINT).Replace(' ', '')
  $certificate = $null
  if ($signingThumbprint) {
    if (-not $timestampServer) { throw 'ARCANE_TIMESTAMP_SERVER is required whenever an Arcane signing certificate is configured.' }
    $certificate = Get-ChildItem -Path Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert |
      Where-Object { $_.Thumbprint -eq $signingThumbprint } | Select-Object -First 1
    if (-not $certificate -or -not $certificate.HasPrivateKey) { throw 'ARCANE_SIGNING_CERT_THUMBPRINT does not identify an available code-signing certificate with a private key.' }
  } elseif ($requireSignedRelease) {
    throw 'A signed release is required, but ARCANE_SIGNING_CERT_THUMBPRINT was not provided.'
  }
  function Sign-ArcaneFile([string]$path) {
    if (-not $certificate) { return }
    $arguments = @{FilePath=$path;Certificate=$certificate;HashAlgorithm='SHA256'}
    if ($timestampServer) { $arguments.TimestampServer=$timestampServer }
    $signature = Set-AuthenticodeSignature @arguments
    if ($signature.Status -ne 'Valid') { throw "Authenticode signing failed for $([IO.Path]::GetFileName($path)): $($signature.StatusMessage)" }
    if (-not $signature.TimeStamperCertificate) { throw "Authenticode timestamping failed for $([IO.Path]::GetFileName($path))." }
  }
  Sign-ArcaneFile (Join-Path $bin 'ArcaneCore.exe')
  Sign-ArcaneFile $pipeGuardTarget

  $contentOutput = & node (Join-Path $root 'tools\machine-content.mjs') write $release
  if ($LASTEXITCODE -ne 0) { throw 'Writing the bound machine content manifest failed.' }
  $content = ($contentOutput | Select-Object -Last 1) | ConvertFrom-Json
  $contentHash = ([string]$content.sha256).ToLowerInvariant()
  if ($contentHash -notmatch '^[a-f0-9]{64}$') { throw 'The machine content manifest did not return a valid SHA-256 binding.' }
  $machineBinding = "ARCANE-MACHINE-BINDING|1|$($bundle.version)|$contentHash"

  function Build-Host([string]$output, [string]$define, [string]$title) {
    $target = Join-Path $bin $output
    $assemblyInfo = Join-Path $packageRoot ".ArcaneAssemblyInfo-$define.cs"
    $assemblySource = @"
using System.Reflection;
[assembly: AssemblyTitle("$title")]
[assembly: AssemblyProduct("Arcane OS")]
[assembly: AssemblyCompany("Arcane OS")]
[assembly: AssemblyDescription("Arcane OS native WebView2 host")]
[assembly: AssemblyVersion("$numericVersion")]
[assembly: AssemblyFileVersion("$numericVersion")]
[assembly: AssemblyInformationalVersion("$($bundle.version)")]
[assembly: AssemblyMetadata("ArcaneContentBinding", "$machineBinding")]
"@
    [IO.File]::WriteAllText($assemblyInfo, $assemblySource, $utf8)
    $arguments = @(
      '/nologo','/target:winexe','/platform:x64','/optimize+','/debug-','/warn:4',
      "/define:$define","/win32icon:$icon","/out:$target",'/reference:System.dll','/reference:System.Core.dll',
      '/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',
      "/reference:$coreDll","/reference:$formsDll",$source,$assemblyInfo
    )
    & $csc $arguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "$output compilation failed." }
    Sign-ArcaneFile $target
  }
  Build-Host 'ArcaneProvisioner.exe' 'ARCANE_PROVISIONER' 'Arcane Provisioner'
  Build-Host 'ArcaneShell.exe' 'ARCANE_SHELL' 'Arcane Shell'
  if (-not $certificate) { Write-Warning 'This local release is unsigned. Use the explicit unsigned-local flag only for controlled tests.' }

  & node (Join-Path $root 'tools\verify-content-bindings.mjs') machine $release ([string]$bundle.version) $contentHash
  if ($LASTEXITCODE -ne 0) { throw 'The compiled machine content binding verification failed.' }
  & (Join-Path $root 'tools\verify-windows-host-dispatch.ps1') -Dist $bin
  & node (Join-Path $root 'tools\smoke-test-windows-pipe-guard.mjs') $pipeGuardTarget
  if ($LASTEXITCODE -ne 0) { throw 'ArcanePipeGuard kernel peer-identity smoke test failed.' }
  & (Join-Path $root 'tools\verify-windows-release-security.ps1') -ReleaseRoot $release -ExpectedBinding $machineBinding -RequireSigned:$requireSignedRelease
  Write-Host "Arcane $($bundle.version) bound Windows hosts are ready in $bin."
} finally {
  if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
}
