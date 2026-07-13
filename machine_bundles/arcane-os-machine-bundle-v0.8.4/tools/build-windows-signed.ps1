param(
  [ValidateSet('release','apps','app')][string]$Target = 'release',
  [string]$AppId,
  [string]$CertificateThumbprint,
  [string]$TimestampServer,
  [string]$SignToolPath,
  [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $PSScriptRoot 'windows-signing.psm1') -Force

$plan = Get-ArcaneSignedWindowsBuildPlan -Target $Target -AppId $AppId
$currentPolicy = ([string]$env:ARCANE_REQUIRE_SIGNED_RELEASE).Trim()
if ($currentPolicy -and $currentPolicy -ne '1') {
  throw 'The signed Windows build conflicts with ARCANE_REQUIRE_SIGNED_RELEASE; clear it or set it to 1.'
}

$signingThumbprint = ([string]$CertificateThumbprint).Trim()
if (-not $signingThumbprint) { $signingThumbprint = [string]$env:ARCANE_SIGNING_CERT_THUMBPRINT }
$expectedPublisherThumbprint = ([string]$env:ARCANE_EXPECTED_PUBLISHER_THUMBPRINT).Trim()
if (-not $expectedPublisherThumbprint) { $expectedPublisherThumbprint = $signingThumbprint }
$timestamp = ([string]$TimestampServer).Trim()
if (-not $timestamp) { $timestamp = [string]$env:ARCANE_TIMESTAMP_SERVER }
$configuredSignTool = ([string]$SignToolPath).Trim()
if (-not $configuredSignTool) { $configuredSignTool = [string]$env:ARCANE_SIGNTOOL_PATH }

$signing = Resolve-ArcaneWindowsSigningContext `
  -RequireSigned $true `
  -SigningThumbprint $signingThumbprint `
  -ExpectedPublisherThumbprint $expectedPublisherThumbprint `
  -TimestampServer $timestamp `
  -SignToolPath $configuredSignTool

Write-Host "Arcane signing preflight passed for $($signing.Certificate.Subject)."
Write-Host "  Certificate: $($signing.SigningThumbprint) ($($signing.CertificateStore))"
Write-Host "  Timestamp:   $($signing.TimestampServer)"
Write-Host "  SignTool:    $($signing.SignToolPath)"
if ($PreflightOnly) {
  Write-Host "Signed Windows $($plan.Target) build is ready. No build was started."
  return
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $npm) { throw 'The signed Windows build requires npm on PATH.' }

$environmentNames = @(
  'ARCANE_REQUIRE_SIGNED_RELEASE',
  'ARCANE_SIGNING_CERT_THUMBPRINT',
  'ARCANE_EXPECTED_PUBLISHER_THUMBPRINT',
  'ARCANE_TIMESTAMP_SERVER',
  'ARCANE_SIGNTOOL_PATH'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location $root
try {
  [Environment]::SetEnvironmentVariable('ARCANE_REQUIRE_SIGNED_RELEASE', '1', 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_SIGNING_CERT_THUMBPRINT', $signing.SigningThumbprint, 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_EXPECTED_PUBLISHER_THUMBPRINT', $signing.ExpectedPublisherThumbprint, 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_TIMESTAMP_SERVER', $signing.TimestampServer, 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_SIGNTOOL_PATH', $signing.SignToolPath, 'Process')

  $npmArguments = @($plan.Arguments)
  & $npm.Source @npmArguments
  if ($LASTEXITCODE -ne 0) {
    throw "The signed Windows $($plan.Target) build failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
}
