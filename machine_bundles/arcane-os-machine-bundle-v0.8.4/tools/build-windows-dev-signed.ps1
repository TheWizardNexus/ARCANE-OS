param(
  [ValidateSet('release','apps','app')][string]$Target = 'release',
  [string]$AppId,
  [string]$TimestampServer = 'http://timestamp.acs.microsoft.com',
  [string]$SignToolPath,
  [switch]$BootstrapOnly
)

$ErrorActionPreference = 'Stop'
if ([string]$env:OS -cne 'Windows_NT') { throw 'Arcane local development signing is available only on Windows.' }

$root = Split-Path -Parent $PSScriptRoot
$subject = 'CN=The Wizard Nexus Development'
$friendlyName = 'Arcane OS Local Development Code Signing'
$minimumExpiry = (Get-Date).AddDays(30)

function Find-ArcaneDevelopmentCertificate {
  return Get-ChildItem -Path Cert:\CurrentUser\My -CodeSigningCert -ErrorAction Stop |
    Where-Object {
      $_.Subject -ceq $subject -and
      $_.FriendlyName -ceq $friendlyName -and
      $_.HasPrivateKey -and
      $_.NotBefore -le (Get-Date) -and
      $_.NotAfter -gt $minimumExpiry
    } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
}

function Add-PublicCertificateToCurrentUserStore {
  param(
    [Parameter(Mandatory=$true)][byte[]]$CertificateBytes,
    [Parameter(Mandatory=$true)][string]$StoreName,
    [Parameter(Mandatory=$true)][string]$Thumbprint
  )

  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    $StoreName,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $existing = $store.Certificates.Find(
      [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
      $Thumbprint,
      $false)
    if ($existing.Count -eq 0) {
      $publicCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificateBytes)
      try { $store.Add($publicCertificate) } finally { $publicCertificate.Dispose() }
    }
  } finally {
    $store.Close()
  }
}

$certificate = Find-ArcaneDevelopmentCertificate
$created = $false
if (-not $certificate) {
  $newSelfSignedCertificate = Get-Command New-SelfSignedCertificate -ErrorAction SilentlyContinue
  if (-not $newSelfSignedCertificate) {
    throw 'Arcane development signing requires the Windows PKI New-SelfSignedCertificate command.'
  }
  $certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -FriendlyName $friendlyName `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeySpec Signature `
    -KeyExportPolicy NonExportable `
    -KeyUsage DigitalSignature `
    -NotBefore (Get-Date).AddMinutes(-5) `
    -NotAfter (Get-Date).AddYears(3)
  $created = $true
}

if (-not $certificate -or -not $certificate.HasPrivateKey -or $certificate.Subject -cne $certificate.Issuer) {
  throw 'Arcane could not create or reuse its self-signed local development certificate.'
}
$thumbprint = ([string]$certificate.Thumbprint).Replace(' ', '').ToUpperInvariant()
if ($thumbprint -cnotmatch '^[A-F0-9]{40,128}$') { throw 'Arcane created an invalid development certificate thumbprint.' }

$publicBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
Add-PublicCertificateToCurrentUserStore -CertificateBytes $publicBytes -StoreName 'Root' -Thumbprint $thumbprint
Add-PublicCertificateToCurrentUserStore -CertificateBytes $publicBytes -StoreName 'TrustedPublisher' -Thumbprint $thumbprint

foreach ($storeName in @('Root', 'TrustedPublisher')) {
  $trusted = Get-ChildItem -Path "Cert:\CurrentUser\$storeName" -ErrorAction Stop |
    Where-Object { ([string]$_.Thumbprint).Replace(' ', '').ToUpperInvariant() -ceq $thumbprint } |
    Select-Object -First 1
  if (-not $trusted) { throw "Arcane could not trust its development certificate in CurrentUser\$storeName." }
}

$publicDirectory = Join-Path $root '.cache\development-signing'
$publicCertificatePath = Join-Path $publicDirectory "$thumbprint.cer"
New-Item -ItemType Directory -Path $publicDirectory -Force | Out-Null
[IO.File]::WriteAllBytes($publicCertificatePath, $publicBytes)

$disposition = if ($created) { 'Created' } else { 'Reused' }
Write-Host "$disposition local development signer: $subject"
Write-Host "  Thumbprint: $thumbprint"
Write-Host '  Trust:      CurrentUser\Root and CurrentUser\TrustedPublisher'
Write-Host "  Public cert: $publicCertificatePath"
Write-Warning 'This certificate is trusted only for local development by the current Windows user. Never distribute its builds as Arcane production releases.'

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

try {
  [Environment]::SetEnvironmentVariable('ARCANE_REQUIRE_SIGNED_RELEASE', '1', 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_SIGNING_CERT_THUMBPRINT', $thumbprint, 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_EXPECTED_PUBLISHER_THUMBPRINT', $thumbprint, 'Process')
  [Environment]::SetEnvironmentVariable('ARCANE_TIMESTAMP_SERVER', $TimestampServer, 'Process')

  $buildParameters = @{
    Target = $Target
    CertificateThumbprint = $thumbprint
    TimestampServer = $TimestampServer
  }
  if ($AppId) { $buildParameters.AppId = $AppId }
  if ($SignToolPath) { $buildParameters.SignToolPath = $SignToolPath }
  if ($BootstrapOnly) { $buildParameters.PreflightOnly = $true }
  & (Join-Path $PSScriptRoot 'build-windows-signed.ps1') @buildParameters
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
}
