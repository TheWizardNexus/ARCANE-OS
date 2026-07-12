param(
  [string]$Dist
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Dist)) { $Dist = Join-Path $root 'dist\windows' }
$dist = [IO.Path]::GetFullPath($Dist)
$source = Join-Path $root 'src\hosts\windows\ArcaneHost.cs'
$pipeGuardSource = Join-Path $root 'src\hosts\windows\ArcanePipeGuard.cs'
$icon = Join-Path $root 'assets\arcane-sigil.ico'
$cache = Join-Path $root '.cache\webview2'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
New-Item -ItemType Directory -Path $cache -Force | Out-Null

if (-not (Test-Path (Join-Path $dist 'ArcaneCore.exe'))) {
  throw 'ArcaneCore.exe is missing. Run npm run build:core:win before building the WebView2 hosts.'
}

$bundle = Get-Content -Raw -LiteralPath (Join-Path $root 'arcane-bundle.json') | ConvertFrom-Json
$version = [string]$bundle.build.webview2SdkVersion
$expectedPackageHash = ([string]$bundle.build.webview2SdkSha256).ToLowerInvariant()
if (-not $version -or $expectedPackageHash -notmatch '^[a-f0-9]{64}$') {
  throw 'arcane-bundle.json must pin the WebView2 SDK version and SHA-256.'
}
$package = Join-Path $cache "microsoft.web.webview2.$version.nupkg"
if (-not (Test-Path $package)) {
  $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg"
  Write-Host "Downloading pinned WebView2 SDK $version..."
  Invoke-WebRequest -Uri $url -OutFile $package -UseBasicParsing
}
$actualPackageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant()
if ($actualPackageHash -ne $expectedPackageHash) {
  throw "The cached WebView2 SDK package failed SHA-256 verification. Expected $expectedPackageHash but received $actualPackageHash."
}
Write-Host "Using verified, pinned Microsoft.Web.WebView2 SDK $version."
$packageRoot = Join-Path $cache ".build-$version-$PID"
if (Test-Path $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($package, $packageRoot)

function Find-SdkFile([string]$name, [string]$preferred) {
  $preferredPath = Join-Path $packageRoot $preferred
  if (Test-Path $preferredPath) { return $preferredPath }
  $match = Get-ChildItem -Path $packageRoot -Recurse -File -Filter $name |
    Where-Object { $_.FullName -notmatch '\\ref\\' } |
    Sort-Object FullName |
    Select-Object -First 1
  if (-not $match) { throw "The WebView2 SDK package does not contain $name." }
  return $match.FullName
}

$coreDll = Find-SdkFile 'Microsoft.Web.WebView2.Core.dll' 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$formsDll = Find-SdkFile 'Microsoft.Web.WebView2.WinForms.dll' 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$loaderDll = Find-SdkFile 'WebView2Loader.dll' 'runtimes\win-x64\native\WebView2Loader.dll'
Copy-Item $coreDll (Join-Path $dist 'Microsoft.Web.WebView2.Core.dll') -Force
Copy-Item $formsDll (Join-Path $dist 'Microsoft.Web.WebView2.WinForms.dll') -Force
Copy-Item $loaderDll (Join-Path $dist 'WebView2Loader.dll') -Force

$candidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'The .NET Framework C# compiler was not found. Enable .NET Framework 4.x developer tools.' }

function Build-Host([string]$output, [string]$define, [string]$title) {
  $target = Join-Path $dist $output
  $numericVersion = "$($bundle.version).0"
  if ($numericVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "Arcane version $($bundle.version) cannot be embedded in a Windows assembly." }
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
"@
  [IO.File]::WriteAllText($assemblyInfo, $assemblySource, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Building $output with the Arcane icon..."
  $arguments = @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-', '/warn:4',
    "/define:$define", "/win32icon:$icon", "/out:$target",
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    "/reference:$coreDll", "/reference:$formsDll", $source, $assemblyInfo
  )
  & $csc $arguments
  if ($LASTEXITCODE -ne 0) { throw "$output compilation failed with exit code $LASTEXITCODE." }
  if (-not (Test-Path $target)) { throw "$output was not produced." }
}

Build-Host 'ArcaneProvisioner.exe' 'ARCANE_PROVISIONER' 'Arcane Provisioner'
Build-Host 'ArcaneShell.exe' 'ARCANE_SHELL' 'Arcane Shell'

$pipeGuardTarget = Join-Path $dist 'ArcanePipeGuard.exe'
$pipeGuardAssemblyInfo = Join-Path $packageRoot '.ArcanePipeGuardAssemblyInfo.cs'
$pipeGuardNumericVersion = "$($bundle.version).0"
$pipeGuardAssemblySource = @"
using System.Reflection;
[assembly: AssemblyTitle("Arcane Pipe Guard")]
[assembly: AssemblyProduct("Arcane OS")]
[assembly: AssemblyCompany("Arcane OS")]
[assembly: AssemblyDescription("Kernel-bound Windows named-pipe peer verifier")]
[assembly: AssemblyVersion("$pipeGuardNumericVersion")]
[assembly: AssemblyFileVersion("$pipeGuardNumericVersion")]
[assembly: AssemblyInformationalVersion("$($bundle.version)")]
"@
[IO.File]::WriteAllText($pipeGuardAssemblyInfo, $pipeGuardAssemblySource, (New-Object Text.UTF8Encoding($false)))
Write-Host 'Building ArcanePipeGuard.exe...'
$pipeGuardArguments = @(
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/debug-', '/warn:4',
  "/win32icon:$icon", "/out:$pipeGuardTarget",
  '/reference:System.dll', '/reference:System.Core.dll', $pipeGuardSource, $pipeGuardAssemblyInfo
)
& $csc $pipeGuardArguments
if ($LASTEXITCODE -ne 0) { throw "ArcanePipeGuard.exe compilation failed with exit code $LASTEXITCODE." }
if (-not (Test-Path -LiteralPath $pipeGuardTarget -PathType Leaf)) { throw 'ArcanePipeGuard.exe was not produced.' }

$requireSignedRelease = $env:ARCANE_REQUIRE_SIGNED_RELEASE -eq '1'
$timestampServer = ([string]$env:ARCANE_TIMESTAMP_SERVER).Trim()
$signingThumbprint = ([string]$env:ARCANE_SIGNING_CERT_THUMBPRINT).Replace(' ', '')
if ($requireSignedRelease -and -not $timestampServer) {
  throw 'A production-signed release requires ARCANE_TIMESTAMP_SERVER so signatures remain verifiable after certificate expiry.'
}
if ($signingThumbprint) {
  $certificate = Get-ChildItem -Path Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert |
    Where-Object { $_.Thumbprint -eq $signingThumbprint } |
    Select-Object -First 1
  if (-not $certificate -or -not $certificate.HasPrivateKey) {
    throw 'ARCANE_SIGNING_CERT_THUMBPRINT does not identify an available code-signing certificate with a private key.'
  }
  foreach ($fileName in @('ArcaneProvisioner.exe', 'ArcaneShell.exe', 'ArcaneCore.exe', 'ArcanePipeGuard.exe')) {
    $signingArguments = @{
      FilePath = (Join-Path $dist $fileName)
      Certificate = $certificate
      HashAlgorithm = 'SHA256'
    }
    if ($timestampServer) { $signingArguments.TimestampServer = $timestampServer }
    $signature = Set-AuthenticodeSignature @signingArguments
    if ($signature.Status -ne 'Valid') { throw "Authenticode signing failed for ${fileName}: $($signature.StatusMessage)" }
    if ($requireSignedRelease -and -not $signature.TimeStamperCertificate) { throw "Authenticode timestamping failed for ${fileName}." }
    Write-Host "Signed $fileName with $($certificate.Subject)."
  }
} elseif ($requireSignedRelease) {
  throw 'A signed release is required, but ARCANE_SIGNING_CERT_THUMBPRINT was not provided.'
} else {
  Write-Warning 'This local release is unsigned. Set ARCANE_SIGNING_CERT_THUMBPRINT and ARCANE_REQUIRE_SIGNED_RELEASE=1 for distribution builds.'
}

& (Join-Path $root 'tools\verify-windows-host-dispatch.ps1') -Dist $dist

node (Join-Path $root 'tools\smoke-test-windows-pipe-guard.mjs') (Join-Path $dist 'ArcanePipeGuard.exe')
if ($LASTEXITCODE -ne 0) { throw 'ArcanePipeGuard kernel peer-identity smoke test failed.' }

node (Join-Path $root 'tools\write-release-manifest.mjs') windows $dist
if ($LASTEXITCODE -ne 0) { throw 'Writing the Windows release manifest failed.' }
Remove-Item -LiteralPath $packageRoot -Recurse -Force
Write-Host "Arcane $($bundle.version) Windows WebView2 release is ready in dist\."
