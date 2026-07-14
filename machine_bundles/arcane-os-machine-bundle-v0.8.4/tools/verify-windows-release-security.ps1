param(
  [Parameter(Mandatory=$true)][string]$ReleaseRoot,
  [string]$TargetAppId,
  [Parameter(Mandatory=$true)][string]$ExpectedBinding,
  [string]$ExpectedPublisherThumbprint = ([string]$env:ARCANE_EXPECTED_PUBLISHER_THUMBPRINT),
  [switch]$RequireSigned
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
$normalizedExpectedPublisherThumbprint = ([string]$ExpectedPublisherThumbprint).Replace(' ', '').ToUpperInvariant()
if ($normalizedExpectedPublisherThumbprint -and $normalizedExpectedPublisherThumbprint -cnotmatch '^[A-F0-9]{40,128}$') {
  throw 'ARCANE_EXPECTED_PUBLISHER_THUMBPRINT must be a 40-128 character hexadecimal certificate thumbprint.'
}
if (-not (Test-Path -LiteralPath $release -PathType Container)) { throw 'The Arcane release security verifier requires an existing release directory.' }
if ($ExpectedBinding -cnotmatch '^ARCANE-(?:MACHINE|TARGET)-BINDING\|1\|[a-z0-9.-]+\|[a-f0-9]{64}$') { throw 'The expected native content binding is malformed.' }

if ($TargetAppId) {
  if ($TargetAppId -cnotmatch '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' -or $TargetAppId -cmatch '^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$') {
    throw 'The target app id is invalid or Windows-reserved.'
  }
  $manifestHash = ($ExpectedBinding -split '\|')[-1]
  & node (Join-Path $root 'tools\verify-content-bindings.mjs') target $release $TargetAppId $manifestHash
  if ($LASTEXITCODE -ne 0) { throw 'Target binding verification failed.' }
  $executables = @(
    (Join-Path $release "ArcaneApp-$TargetAppId.exe"),
    (Join-Path $release 'ArcaneCore.exe'),
    (Join-Path $release 'ArcanePipeGuard.exe')
  )
  $nativeHosts = @((Join-Path $release "ArcaneApp-$TargetAppId.exe"))
} else {
  $parts = $ExpectedBinding -split '\|'
  $manifestHash = $parts[-1]
  $version = $parts[-2]
  & node (Join-Path $root 'tools\verify-content-bindings.mjs') machine $release $version $manifestHash
  if ($LASTEXITCODE -ne 0) { throw 'Machine binding verification failed.' }

  $catalogPath = Join-Path $release 'apps\catalog.json'
  if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'The installed-app catalog is missing from the Windows release.' }
  $catalog = Get-Content -Raw -LiteralPath $catalogPath | ConvertFrom-Json
  $catalogApps = @($catalog.apps)
  if ($catalogApps.Count -eq 0) { throw 'The installed-app catalog contains no applications.' }
  $seenAppIds = @{}
  foreach ($app in $catalogApps) {
    $appId = [string]$app.id
    if ($appId -cnotmatch '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' -or $appId -cmatch '^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$') {
      throw 'The installed-app catalog contains an invalid or Windows-reserved app id.'
    }
    if ($seenAppIds.ContainsKey($appId)) { throw "The installed-app catalog repeats app id $appId." }
    $seenAppIds[$appId] = $true
    $expectedTargetHash = [string]$app.contentManifestSha256
    if ($expectedTargetHash -cnotmatch '^[a-f0-9]{64}$') { throw "The installed-app catalog has an invalid content binding for $appId." }
    $appRoot = Join-Path $release "apps\$appId"
    $contentPath = Join-Path $appRoot 'arcane-app-content.json'
    if (-not (Test-Path -LiteralPath $contentPath -PathType Leaf)) { throw "The installed app $appId is missing its content manifest." }
    $actualTargetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $contentPath).Hash.ToLowerInvariant()
    if ($actualTargetHash -cne $expectedTargetHash) { throw "The installed-app catalog content binding does not match $appId." }
    & node (Join-Path $root 'tools\verify-content-bindings.mjs') target $appRoot $appId $expectedTargetHash
    if ($LASTEXITCODE -ne 0) { throw "Target binding verification failed for $appId." }
  }
  $executables = @(Get-ChildItem -LiteralPath $release -Recurse -File -Filter '*.exe' | Sort-Object FullName | Select-Object -ExpandProperty FullName)
  $nativeHosts = @(
    (Join-Path $release 'bin\ArcaneProvisioner.exe'),
    (Join-Path $release 'bin\ArcaneShell.exe')
  )
}
if ($executables.Count -eq 0) { throw 'The Arcane release contains no executables to authenticate.' }
foreach ($file in $executables) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing Arcane executable: $file" } }

$evidence = foreach ($file in $executables) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  [pscustomobject]@{
    File=$file
    Status=[string]$signature.Status
    Thumbprint=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Thumbprint}else{$null}
    Timestamped=[bool]$signature.TimeStamperCertificate
    Message=[string]$signature.StatusMessage
  }
}
$invalid = @($evidence | Where-Object { $_.Status -notin @('Valid','NotSigned') })
if ($invalid.Count) { throw "Arcane release contains an invalid signature on $($invalid[0].File): $($invalid[0].Status) $($invalid[0].Message)" }
$statuses = @($evidence | Select-Object -ExpandProperty Status -Unique)
if ($statuses.Count -ne 1) { throw 'Arcane release mixes signed and unsigned executables.' }
if ($statuses[0] -eq 'Valid') {
  $signers = @($evidence | Select-Object -ExpandProperty Thumbprint -Unique)
  if ($signers.Count -ne 1 -or [string]::IsNullOrWhiteSpace($signers[0])) { throw 'Arcane release executables do not share one signer certificate.' }
  if (@($evidence | Where-Object { -not $_.Timestamped }).Count) { throw 'Every signed Arcane executable must have an Authenticode timestamp.' }
  $actualPublisherThumbprint = ([string]$signers[0]).Replace(' ', '').ToUpperInvariant()
  if (-not $normalizedExpectedPublisherThumbprint) { throw 'Signed Arcane verification requires the externally configured ARCANE_EXPECTED_PUBLISHER_THUMBPRINT trust anchor.' }
  if ($actualPublisherThumbprint -cne $normalizedExpectedPublisherThumbprint) { throw 'The Arcane release signer does not match the externally configured publisher trust anchor.' }
  $expectedPublisherMarker = 'ARCANE-PUBLISHER|1|' + $normalizedExpectedPublisherThumbprint
  Write-Host "Verified $($evidence.Count) Arcane executables against the configured publisher trust anchor $normalizedExpectedPublisherThumbprint."
} else {
  if ($RequireSigned) { throw 'Production Arcane releases cannot contain unsigned executables.' }
  if ($normalizedExpectedPublisherThumbprint) { throw 'Unsigned local-test verification conflicts with ARCANE_EXPECTED_PUBLISHER_THUMBPRINT.' }
  $expectedPublisherMarker = 'ARCANE-PUBLISHER|1|UNSIGNED-LOCAL-TEST'
  Write-Warning "Verified a consistently unsigned local-test Arcane release with $($evidence.Count) executables."
}

function Get-ArcaneMarkerCount([string]$File, [string]$Marker) {
  $bytes = [IO.File]::ReadAllBytes($File)
  $escaped = [Regex]::Escape($Marker)
  $ascii = [Text.Encoding]::ASCII.GetString($bytes)
  $unicode = [Text.Encoding]::Unicode.GetString($bytes)
  return ([Regex]::Matches($ascii, $escaped)).Count + ([Regex]::Matches($unicode, $escaped)).Count
}
foreach ($nativeHost in $nativeHosts) {
  if (-not (Test-Path -LiteralPath $nativeHost -PathType Leaf)) { throw "Missing Arcane native host: $nativeHost" }
  $markerCount = Get-ArcaneMarkerCount -File $nativeHost -Marker $expectedPublisherMarker
  if ($markerCount -ne 1) { throw "$nativeHost must contain exactly one configured publisher binding; found $markerCount." }
}
Write-Host "Verified configured publisher binding $expectedPublisherMarker in $($nativeHosts.Count) native host(s)."
