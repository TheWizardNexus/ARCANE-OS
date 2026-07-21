param(
  [ValidateSet('release','apps','app')][string]$Target = 'release',
  [string]$AppId,
  [string]$TimestampServer = 'http://timestamp.acs.microsoft.com',
  [string]$SignToolPath,
  [switch]$BootstrapOnly
)

$ErrorActionPreference = 'Stop'
if ([string]$env:OS -cne 'Windows_NT') { throw 'Arcane local development signing is available only on Microsoft NT.' }

$root = Split-Path -Parent $PSScriptRoot
$subject = 'CN=The Wizard Nexus Development'
$friendlyName = 'Arcane OS Local Development Code Signing'
$minimumExpiry = (Get-Date).AddDays(30)

function Test-ArcaneDevelopmentCertificate {
  param([Parameter(Mandatory=$true)]$Certificate)

  if ($Certificate.Subject -cne $subject -or
      $Certificate.Issuer -cne $subject -or
      $Certificate.FriendlyName -cne $friendlyName -or
      -not $Certificate.HasPrivateKey -or
      $Certificate.NotBefore -gt (Get-Date) -or
      $Certificate.NotAfter -le $minimumExpiry -or
      $Certificate.SignatureAlgorithm.Value -cne '1.2.840.113549.1.1.11' -or
      $Certificate.PublicKey.Oid.Value -cne '1.2.840.113549.1.1.1') {
    return $false
  }

  $hasCodeSigningUsage = @($Certificate.EnhancedKeyUsageList |
    Where-Object { [string]$_.ObjectId -ceq '1.3.6.1.5.5.7.3.3' }).Count -gt 0
  $keyUsage = $Certificate.Extensions |
    Where-Object { $_.Oid.Value -ceq '2.5.29.15' } |
    Select-Object -First 1
  $basicConstraints = $Certificate.Extensions |
    Where-Object { $_.Oid.Value -ceq '2.5.29.19' } |
    Select-Object -First 1
  if (-not $hasCodeSigningUsage -or
      -not $keyUsage -or
      (($keyUsage.KeyUsages -band [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) -eq 0) -or
      ($basicConstraints -and $basicConstraints.CertificateAuthority)) {
    return $false
  }

  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
  if (-not $rsa) { return $false }
  try {
    if ($rsa.KeySize -lt 3072) { return $false }
    if ($rsa -is [System.Security.Cryptography.RSACng]) {
      return $rsa.Key.ExportPolicy -eq [System.Security.Cryptography.CngExportPolicies]::None
    }
    if ($rsa -is [System.Security.Cryptography.RSACryptoServiceProvider]) {
      return -not $rsa.CspKeyContainerInfo.Exportable
    }
    return $false
  } finally {
    $rsa.Dispose()
  }
}

function Find-ArcaneDevelopmentCertificate {
  return Get-ChildItem -Path Cert:\CurrentUser\My -CodeSigningCert -ErrorAction Stop |
    Where-Object { Test-ArcaneDevelopmentCertificate -Certificate $_ } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
}

function Add-PublicCertificateToCurrentUserStore {
  param(
    [Parameter(Mandatory=$true)][string]$CertificatePath,
    [Parameter(Mandatory=$true)][string]$StoreName,
    [Parameter(Mandatory=$true)][string]$Thumbprint
  )

  $existing = Get-ChildItem -Path "Cert:\CurrentUser\$StoreName" -ErrorAction Stop |
    Where-Object { ([string]$_.Thumbprint).Replace(' ', '').ToUpperInvariant() -ceq $Thumbprint } |
    Select-Object -First 1
  if ($existing) { return }

  $imported = Import-Certificate `
    -FilePath $CertificatePath `
    -CertStoreLocation "Cert:\CurrentUser\$StoreName" `
    -ErrorAction Stop
  $importedThumbprint = ([string]$imported.Thumbprint).Replace(' ', '').ToUpperInvariant()
  if ($importedThumbprint -cne $Thumbprint) {
    throw "Windows imported an unexpected certificate into CurrentUser\$StoreName."
  }
}

$certificate = Find-ArcaneDevelopmentCertificate
$created = $false
if (-not $certificate) {
  if (-not $BootstrapOnly) {
    throw 'Arcane local development signing is not initialized. Run npm run signing:bootstrap:dev:windows once, then retry the build.'
  }
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
$publicDirectory = Join-Path $root '.cache\development-signing'
$publicCertificatePath = Join-Path $publicDirectory "$thumbprint.cer"
New-Item -ItemType Directory -Path $publicDirectory -Force | Out-Null
[IO.File]::WriteAllBytes($publicCertificatePath, $publicBytes)

if ($BootstrapOnly) {
  Write-Warning 'Arcane will directly trust this non-CA development signer in the current user Root and TrustedPublisher stores. Remove it when local Arcane development ends.'
  Add-PublicCertificateToCurrentUserStore -CertificatePath $publicCertificatePath -StoreName 'Root' -Thumbprint $thumbprint
  Add-PublicCertificateToCurrentUserStore -CertificatePath $publicCertificatePath -StoreName 'TrustedPublisher' -Thumbprint $thumbprint
}

foreach ($storeName in @('Root', 'TrustedPublisher')) {
  $trusted = Get-ChildItem -Path "Cert:\CurrentUser\$storeName" -ErrorAction Stop |
    Where-Object { ([string]$_.Thumbprint).Replace(' ', '').ToUpperInvariant() -ceq $thumbprint } |
    Select-Object -First 1
  if (-not $trusted) {
    if ($BootstrapOnly) { throw "Arcane could not trust its development certificate in CurrentUser\$storeName." }
    throw 'Arcane local development trust is not initialized. Run npm run signing:bootstrap:dev:windows once, then retry the build.'
  }
}

$disposition = if ($created) { 'Created' } else { 'Reused' }
Write-Host "$disposition local development signer: $subject"
Write-Host "  Thumbprint: $thumbprint"
Write-Host '  Trust:      CurrentUser\Root and CurrentUser\TrustedPublisher (this non-CA leaf certificate only)'
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
