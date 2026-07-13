Set-StrictMode -Version 2.0

function Normalize-ArcaneCertificateThumbprint {
  param(
    [AllowEmptyString()][string]$Value,
    [Parameter(Mandatory=$true)][string]$VariableName,
    [switch]$Required
  )

  $normalized = ([string]$Value).Replace(' ', '').ToUpperInvariant()
  if (-not $normalized) {
    if ($Required) { throw "$VariableName is required for a signed Windows build." }
    return ''
  }
  if ($normalized -cnotmatch '^[A-F0-9]{40,128}$') {
    throw "$VariableName must be a 40-128 character hexadecimal certificate thumbprint."
  }
  return $normalized
}

function Resolve-ArcaneSignTool {
  param([AllowEmptyString()][string]$ConfiguredPath)

  $configured = ([string]$ConfiguredPath).Trim()
  if ($configured) {
    if (-not (Test-Path -LiteralPath $configured -PathType Leaf) -or
        [IO.Path]::GetFileName($configured) -cne 'signtool.exe') {
      throw 'ARCANE_SIGNTOOL_PATH does not identify signtool.exe.'
    }
    return [IO.Path]::GetFullPath($configured)
  }

  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }

  $programFilesX86 = [string]${env:ProgramFiles(x86)}
  if ($programFilesX86) {
    $kitsRoot = Join-Path $programFilesX86 'Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
      $candidate = Get-ChildItem -Path (Join-Path $kitsRoot '*\x64\signtool.exe') -File -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -ExpandProperty FullName -First 1
      if ($candidate) { return $candidate }
    }
  }

  throw 'A production signed build requires Windows SDK SignTool. Set ARCANE_SIGNTOOL_PATH or install the Windows SDK.'
}

function Resolve-ArcaneWindowsSigningContext {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][bool]$RequireSigned,
    [AllowEmptyString()][string]$SigningThumbprint = ([string]$env:ARCANE_SIGNING_CERT_THUMBPRINT),
    [AllowEmptyString()][string]$ExpectedPublisherThumbprint = ([string]$env:ARCANE_EXPECTED_PUBLISHER_THUMBPRINT),
    [AllowEmptyString()][string]$TimestampServer = ([string]$env:ARCANE_TIMESTAMP_SERVER),
    [AllowEmptyString()][string]$SignToolPath = ([string]$env:ARCANE_SIGNTOOL_PATH)
  )

  $signer = Normalize-ArcaneCertificateThumbprint -Value $SigningThumbprint -VariableName 'ARCANE_SIGNING_CERT_THUMBPRINT' -Required:$RequireSigned
  $expected = Normalize-ArcaneCertificateThumbprint -Value $ExpectedPublisherThumbprint -VariableName 'ARCANE_EXPECTED_PUBLISHER_THUMBPRINT' -Required:([bool]$signer)

  if (-not $signer) {
    if ($expected) { throw 'Unsigned local-test builds conflict with ARCANE_EXPECTED_PUBLISHER_THUMBPRINT.' }
    return [pscustomobject]@{
      Enabled = $false
      Certificate = $null
      CertificateStore = $null
      CertificateMachineStore = $false
      SigningThumbprint = ''
      ExpectedPublisherThumbprint = ''
      TimestampServer = ''
      SignToolPath = $null
      PublisherBinding = 'ARCANE-PUBLISHER|1|UNSIGNED-LOCAL-TEST'
    }
  }

  if ($signer -cne $expected) {
    throw 'ARCANE_SIGNING_CERT_THUMBPRINT must match ARCANE_EXPECTED_PUBLISHER_THUMBPRINT.'
  }

  $timestamp = ([string]$TimestampServer).Trim()
  if (-not $timestamp) { throw 'ARCANE_TIMESTAMP_SERVER is required whenever an Arcane signing certificate is configured.' }
  $timestampUri = $null
  if (-not [Uri]::TryCreate($timestamp, [UriKind]::Absolute, [ref]$timestampUri) -or
      $timestampUri.Scheme -notin @('http', 'https')) {
    throw 'ARCANE_TIMESTAMP_SERVER must be an absolute HTTP or HTTPS RFC 3161 timestamp URL.'
  }
  if ($timestampUri.UserInfo -or $timestampUri.Query -or $timestampUri.Fragment) {
    throw 'ARCANE_TIMESTAMP_SERVER must be a public RFC 3161 endpoint without credentials, a query, or a fragment.'
  }

  $certificate = Get-ChildItem -Path Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert -ErrorAction Stop |
    Where-Object { ([string]$_.Thumbprint).Replace(' ', '').ToUpperInvariant() -ceq $signer } |
    Select-Object -First 1
  if (-not $certificate -or -not $certificate.HasPrivateKey) {
    throw 'ARCANE_SIGNING_CERT_THUMBPRINT does not identify an available code-signing certificate with a private key in CurrentUser\My or LocalMachine\My.'
  }

  $machineStore = [string]$certificate.PSPath -like '*LocalMachine*'
  $resolvedSignTool = Resolve-ArcaneSignTool -ConfiguredPath $SignToolPath

  return [pscustomobject]@{
    Enabled = $true
    Certificate = $certificate
    CertificateStore = if ($machineStore) { 'LocalMachine\My' } else { 'CurrentUser\My' }
    CertificateMachineStore = $machineStore
    SigningThumbprint = $signer
    ExpectedPublisherThumbprint = $expected
    TimestampServer = $timestampUri.AbsoluteUri
    SignToolPath = $resolvedSignTool
    PublisherBinding = 'ARCANE-PUBLISHER|1|' + $expected
  }
}

function Invoke-ArcaneAuthenticodeSign {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][psobject]$Context,
    [Parameter(Mandatory=$true)][string]$Path
  )

  if (-not $Context.Enabled) { return }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Cannot sign missing file: $Path" }
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $signArguments = @(
    'sign', '/sha1', [string]$Context.SigningThumbprint,
    '/fd', 'SHA256', '/tr', [string]$Context.TimestampServer,
    '/td', 'SHA256', '/v'
  )
  if ($Context.CertificateMachineStore) { $signArguments += '/sm' }
  $signArguments += $resolvedPath

  & $Context.SignToolPath @signArguments
  if ($LASTEXITCODE -ne 0) {
    throw "RFC 3161 Authenticode signing failed for $([IO.Path]::GetFileName($resolvedPath))."
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
  if ($signature.Status -ne 'Valid') {
    throw "Authenticode signing failed for $([IO.Path]::GetFileName($resolvedPath)): $($signature.StatusMessage)"
  }
  $actualSigner = if ($signature.SignerCertificate) {
    ([string]$signature.SignerCertificate.Thumbprint).Replace(' ', '').ToUpperInvariant()
  } else { '' }
  if ($actualSigner -cne [string]$Context.ExpectedPublisherThumbprint) {
    throw "Authenticode signer verification failed for $([IO.Path]::GetFileName($resolvedPath))."
  }
  if (-not $signature.TimeStamperCertificate) {
    throw "Authenticode timestamping failed for $([IO.Path]::GetFileName($resolvedPath))."
  }
}

function Get-ArcaneSignedWindowsBuildPlan {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][ValidateSet('release','apps','app')][string]$Target,
    [AllowEmptyString()][string]$AppId
  )

  $normalizedTarget = $Target.ToLowerInvariant()
  if ($normalizedTarget -eq 'app') {
    if (-not $AppId -or $AppId.Length -gt 64 -or
        $AppId -cnotmatch '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' -or
        $AppId -cmatch '^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$') {
      throw 'Target app builds require a valid, non-reserved Arcane app id.'
    }
  } elseif ($AppId) {
    throw '-AppId is valid only when -Target app is selected.'
  }

  $arguments = switch ($normalizedTarget) {
    'release' { @('run', 'build:distribution:windows') }
    'apps' { @('run', 'build:apps:windows') }
    'app' { @('run', 'build:app:windows', '--', "--app=$AppId") }
  }
  return [pscustomobject]@{
    Target = $normalizedTarget
    AppId = if ($normalizedTarget -eq 'app') { $AppId } else { $null }
    Arguments = [string[]]$arguments
  }
}

Export-ModuleMember -Function Resolve-ArcaneWindowsSigningContext,Invoke-ArcaneAuthenticodeSign,Get-ArcaneSignedWindowsBuildPlan
