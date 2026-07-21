[CmdletBinding()]
param(
  [switch]$SkipPrerequisiteInstall,
  [switch]$SkipChecks,
  [switch]$SkipBuild,
  [switch]$SkipSigning
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ([string]$env:OS -cne 'Windows_NT') {
  throw 'The unified Arcane OS developer setup currently supports Microsoft NT only.'
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bundle = Join-Path $root 'machine_bundles\arcane-os-machine-bundle-v0.8.4'
$npmCache = Join-Path $root 'tmp\developer-setup-npm-cache'
$minimumNodeMajor = 22

function Write-ArcaneStep {
  param([Parameter(Mandatory=$true)][string]$Message)
  Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Invoke-External {
  param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][string]$FilePath,
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    [Parameter(Mandatory=$true)][string]$WorkingDirectory
  )

  Write-ArcaneStep $Label
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode." }
}

function Resolve-CommandPath {
  param([Parameter(Mandatory=$true)][string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  return $null
}

function Test-NodeVersion {
  param([AllowNull()][string]$NodePath)
  if (-not $NodePath) { return $false }
  $version = & $NodePath '--version'
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(?<major>\d+)[.]') { return $false }
  return [int]$Matches.major -ge $minimumNodeMajor
}

function Find-WindowsSdkSignTool {
  $configured = ([string]$env:ARCANE_SIGNTOOL_PATH).Trim()
  if ($configured -and (Test-Path -LiteralPath $configured -PathType Leaf)) { return $configured }
  $command = Resolve-CommandPath 'signtool.exe'
  if ($command) { return $command }
  $kitsRoot = Join-Path ([string]${env:ProgramFiles(x86)}) 'Windows Kits\10\bin'
  if (-not (Test-Path -LiteralPath $kitsRoot -PathType Container)) { return $null }
  return Get-ChildItem -Path (Join-Path $kitsRoot '*\x64\signtool.exe') -File -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -ExpandProperty FullName -First 1
}

function Test-WindowsSdk {
  $metadataRoot = Join-Path ([string]${env:ProgramFiles(x86)}) 'Windows Kits\10\UnionMetadata'
  $metadata = if (Test-Path -LiteralPath $metadataRoot -PathType Container) {
    Get-ChildItem -Path (Join-Path $metadataRoot '*\Windows.winmd') -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
  }
  return [bool](Find-WindowsSdkSignTool) -and [bool]$metadata
}

function Install-WinGetPackage {
  param(
    [Parameter(Mandatory=$true)][string]$Id,
    [AllowEmptyString()][string]$Version = ''
  )
  $winget = Resolve-CommandPath 'winget.exe'
  if (-not $winget) {
    throw "WinGet is required to install $Id. Install Microsoft App Installer or rerun with prerequisites already installed."
  }
  $arguments = @(
    'install', '--id', $Id, '--exact', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements',
    '--silent', '--disable-interactivity'
  )
  if ($Version) { $arguments += @('--version', $Version) }
  Invoke-External -Label "Installing $Id" -FilePath $winget -Arguments $arguments -WorkingDirectory $root
  Refresh-ProcessPath
}

function Preserve-IncompatiblePnpmTree {
  param(
    [Parameter(Mandatory=$true)][string]$WorkingDirectory,
    [Parameter(Mandatory=$true)][string]$Label
  )
  $nodeModules = Join-Path $WorkingDirectory 'node_modules'
  if (-not (Test-Path -LiteralPath (Join-Path $nodeModules '.pnpm') -PathType Container)) { return }

  $backupRoot = Join-Path $root 'tmp\developer-setup-dependency-backups'
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $safeLabel = $Label -replace '[^a-zA-Z0-9.-]', '-'
  $backup = Join-Path $backupRoot "$safeLabel-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))"
  Write-Warning "$Label uses a pnpm hardlinked dependency tree that npm cannot reliably clean on Microsoft NT. Preserving it at $backup before npm ci."
  Move-Item -LiteralPath $nodeModules -Destination $backup
}

function Remove-UntrackedVendoredDependencyFiles {
  $vendorRoot = [IO.Path]::GetFullPath((Join-Path $root 'node_modules\strong-type')).TrimEnd('\')
  $relativeFiles = @(& $git -C $root ls-files --others --exclude-standard -- 'node_modules/strong-type')
  if ($LASTEXITCODE -ne 0) { throw 'Git could not inspect the vendored strong-type dependency after npm ci.' }
  foreach ($relative in $relativeFiles) {
    if (-not $relative) { continue }
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $candidate.StartsWith($vendorRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean an untracked dependency file outside $vendorRoot."
    }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { Remove-Item -LiteralPath $candidate -Force }
  }
  if (Test-Path -LiteralPath $vendorRoot -PathType Container) {
    Get-ChildItem -LiteralPath $vendorRoot -Directory -Recurse -Force |
      Sort-Object FullName -Descending |
      Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } |
      Remove-Item -Force
  }
}

Write-Host 'Arcane OS unified Microsoft NT developer setup' -ForegroundColor Green
Write-Host "Repository: $root"

$git = Resolve-CommandPath 'git.exe'
if (-not $git) {
  if ($SkipPrerequisiteInstall) { throw 'Git is required but was not found.' }
  Install-WinGetPackage -Id 'Git.Git'
  $git = Resolve-CommandPath 'git.exe'
}
if (-not $git) { throw 'Git installation completed but git.exe is still unavailable. Reopen the terminal and retry.' }

$node = Resolve-CommandPath 'node.exe'
if (-not (Test-NodeVersion -NodePath $node)) {
  if ($SkipPrerequisiteInstall) { throw 'Node.js 22 or newer is required but was not found.' }
  Install-WinGetPackage -Id 'OpenJS.NodeJS.22' -Version '22.23.1'
  $node = Resolve-CommandPath 'node.exe'
}
if (-not (Test-NodeVersion -NodePath $node)) { throw 'Node.js 22 or newer is still unavailable after prerequisite setup.' }

$npm = Resolve-CommandPath 'npm.cmd'
if (-not $npm) { throw 'npm.cmd is required and must be installed with Node.js.' }

if (-not (Test-WindowsSdk)) {
  if ($SkipPrerequisiteInstall) { throw 'The Windows 10.0.26100 SDK, including SignTool and Windows.winmd, is required.' }
  Install-WinGetPackage -Id 'Microsoft.WindowsSDK.10.0.26100'
}
if (-not (Test-WindowsSdk)) { throw 'The Windows SDK installation completed but required build tools are still unavailable.' }

if (-not (Get-Command New-SelfSignedCertificate -ErrorAction SilentlyContinue) -and -not $SkipSigning) {
  throw 'Microsoft NT PKI support with New-SelfSignedCertificate is required for development signing.'
}

Invoke-External -Label 'Verifying public package-lock registries' -FilePath $node `
  -Arguments @('tools\verify-package-lock-registries.mjs') -WorkingDirectory $root
Preserve-IncompatiblePnpmTree -WorkingDirectory $root -Label 'repository'
Invoke-External -Label 'Installing repository dependencies' -FilePath $npm `
  -Arguments @('ci', '--no-audit', '--no-fund', '--cache', $npmCache) -WorkingDirectory $root
Remove-UntrackedVendoredDependencyFiles
Preserve-IncompatiblePnpmTree -WorkingDirectory $bundle -Label 'machine-bundle'
Invoke-External -Label 'Installing machine-bundle dependencies' -FilePath $npm `
  -Arguments @('ci', '--no-audit', '--no-fund', '--cache', $npmCache) -WorkingDirectory $bundle
Invoke-External -Label 'Installing repository Git hooks' -FilePath $npm `
  -Arguments @('run', 'hooks:install') -WorkingDirectory $root

if (-not $SkipChecks) {
  Invoke-External -Label 'Running Arcane repository checks' -FilePath $npm `
    -Arguments @('run', 'check') -WorkingDirectory $root
}

if (-not $SkipSigning) {
  Write-Warning 'The next step creates or reuses a non-exportable per-user development certificate and trusts only that development leaf certificate for the current Microsoft NT user.'
  Invoke-External -Label 'Initializing local Microsoft NT development signing' -FilePath $npm `
    -Arguments @('run', 'signing:bootstrap:dev:windows') -WorkingDirectory $root
}

if (-not $SkipBuild) {
  if ($SkipSigning) {
    Invoke-External -Label 'Building the unsigned local-test Microsoft NT distribution' -FilePath $npm `
      -Arguments @('run', 'build:distribution:windows:unsigned-local-test') -WorkingDirectory $bundle
  } else {
    Invoke-External -Label 'Building the development-signed Microsoft NT distribution' -FilePath $npm `
      -Arguments @('run', 'build:dev:windows') -WorkingDirectory $root
  }
}

Write-ArcaneStep 'Developer setup complete'
Write-Host "Node:         $(& $node '--version')"
Write-Host "npm:          $(& $npm '--version')"
Write-Host "Git:          $(& $git '--version')"
Write-Host "Windows SDK:  $(Find-WindowsSdkSignTool)"
if (-not $SkipBuild) {
  Write-Host "Microsoft NT distribution: $(Join-Path $bundle 'dist\nt')"
}
Write-Host 'Production signing material was not created, read, or modified.'
