param(
  [string]$Dist = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\windows'),
  [string[]]$Files = @('ArcaneProvisioner.exe', 'ArcaneShell.exe')
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ArcaneDispatchProbe
{
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetIDsOfNames(
        IntPtr self,
        ref Guid interfaceId,
        IntPtr names,
        uint nameCount,
        uint localeId,
        IntPtr dispatchIds
    );

    public static int GetDispatchId(object instance, string name)
    {
        IntPtr dispatch = IntPtr.Zero;
        IntPtr nameText = IntPtr.Zero;
        IntPtr names = IntPtr.Zero;
        IntPtr dispatchIds = IntPtr.Zero;

        try
        {
            dispatch = Marshal.GetIDispatchForObject(instance);
            IntPtr vtable = Marshal.ReadIntPtr(dispatch);
            IntPtr function = Marshal.ReadIntPtr(vtable, 5 * IntPtr.Size);
            GetIDsOfNames lookup = (GetIDsOfNames)Marshal.GetDelegateForFunctionPointer(
                function,
                typeof(GetIDsOfNames)
            );

            nameText = Marshal.StringToCoTaskMemUni(name);
            names = Marshal.AllocCoTaskMem(IntPtr.Size);
            Marshal.WriteIntPtr(names, nameText);
            dispatchIds = Marshal.AllocCoTaskMem(sizeof(int));
            Marshal.WriteInt32(dispatchIds, -1);

            Guid empty = Guid.Empty;
            int result = lookup(dispatch, ref empty, names, 1, 0, dispatchIds);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return Marshal.ReadInt32(dispatchIds);
        }
        finally
        {
            if (dispatchIds != IntPtr.Zero) Marshal.FreeCoTaskMem(dispatchIds);
            if (names != IntPtr.Zero) Marshal.FreeCoTaskMem(names);
            if (nameText != IntPtr.Zero) Marshal.FreeCoTaskMem(nameText);
            if (dispatch != IntPtr.Zero) Marshal.Release(dispatch);
        }
    }
}
'@

$bindingFlags = [Reflection.BindingFlags]'Instance,NonPublic'
$staticFlags = [Reflection.BindingFlags]'Static,NonPublic'
function Convert-WinTrustHex([string]$value) {
  $bytes = [BitConverter]::GetBytes([Convert]::ToUInt32($value, 16))
  return [BitConverter]::ToInt32($bytes, 0)
}

function Assert-ReflectionThrows(
  [string]$label,
  [Type]$expectedType,
  [string]$expectedMessage,
  [scriptblock]$action
) {
  try {
    $null = & $action
  }
  catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    if ($cause -isnot $expectedType) {
      throw "$label threw $($cause.GetType().FullName) instead of $($expectedType.FullName): $($cause.Message)"
    }
    if ($expectedMessage -and $cause.Message -ne $expectedMessage) {
      throw "$label reported '$($cause.Message)' instead of '$expectedMessage'."
    }
    return
  }
  throw "$label did not reject the unsafe input."
}

function New-EnumVector([Type]$enumType, [string[]]$names) {
  $result = [Array]::CreateInstance($enumType, $names.Count)
  for ($index = 0; $index -lt $names.Count; $index += 1) {
    $result.SetValue([Enum]::Parse($enumType, $names[$index], $false), $index)
  }
  return ,$result
}

function Invoke-LegacyEvidence(
  [Reflection.MethodInfo]$method,
  [Array]$statuses,
  [string[]]$signers,
  [bool[]]$timestamps
) {
  $arguments = New-Object object[] 3
  $arguments[0] = $statuses
  $arguments[1] = $signers
  $arguments[2] = $timestamps
  return $method.Invoke($null, $arguments)
}

function Invoke-SecurityProbe(
  [Reflection.MethodInfo]$method,
  [Security.AccessControl.ObjectSecurity]$security,
  [string]$label
) {
  $arguments = New-Object object[] 2
  $arguments[0] = $security
  $arguments[1] = $label
  return $method.Invoke($null, $arguments)
}

function Format-UtcTimestamp([DateTimeOffset]$value) {
  return $value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

foreach ($fileName in $Files) {
  $path = Join-Path $Dist $fileName
  if (-not (Test-Path -LiteralPath $path)) {
    throw "$fileName is missing. Build the Windows hosts before checking their COM dispatch surface."
  }

  $assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path -LiteralPath $path))
  $bridgeType = $assembly.GetType('ArcaneOS.ArcaneBridge', $true)
  $constructor = $bridgeType.GetConstructors($bindingFlags) |
    Where-Object { $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  if (-not $constructor) {
    throw "$fileName does not contain the expected internal ArcaneBridge constructor."
  }

  $bridge = $constructor.Invoke([object[]]@($null))
  $dispatchId = [ArcaneDispatchProbe]::GetDispatchId($bridge, 'Send')
  if ($dispatchId -lt 0) {
    throw "$fileName exposed Send with an invalid COM dispatch identifier."
  }

  $authenticodeType = $assembly.GetType('ArcaneOS.Authenticode', $true)
  $purposeType = $assembly.GetType('ArcaneOS.AuthenticodePurpose', $true)
  $classify = $authenticodeType.GetMethod('ClassifyTrustResult', $staticFlags)
  $providerFlags = $authenticodeType.GetMethod('ProviderFlagsForPurpose', $staticFlags)
  $emptyCertificateTable = $authenticodeType.GetMethod('HasEmptyPeCertificateTable', $staticFlags)
  if (-not $classify -or -not $providerFlags -or -not $emptyCertificateTable) {
    throw "$fileName does not expose the internal WinTrust policy probes."
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  $certificateTableArguments = New-Object object[] 1
  $certificateTableArguments[0] = [string]$path
  $emptyTable = [bool]$emptyCertificateTable.Invoke($null, $certificateTableArguments)
  if (($signature.Status -eq 'NotSigned' -and -not $emptyTable) -or ($signature.Status -eq 'Valid' -and $emptyTable)) {
    throw "$fileName PE certificate-table proof does not match its Authenticode state."
  }
  $classifications = @{
    '80092010' = 'Revoked'
    '800B010C' = 'Revoked'
    '80092011' = 'RevocationUnavailable'
    '80092012' = 'RevocationUnavailable'
    '80092013' = 'RevocationUnavailable'
    '80092014' = 'RevocationUnavailable'
    '800B010E' = 'RevocationUnavailable'
    '800B0001' = 'Invalid'
    '800B0003' = 'Invalid'
    '80096010' = 'Invalid'
  }
  foreach ($entry in $classifications.GetEnumerator()) {
    $actual = [string]$classify.Invoke($null, [object[]]@((Convert-WinTrustHex $entry.Key)))
    if ($actual -ne $entry.Value) {
      throw "$fileName classified WinTrust 0x$($entry.Key) as $actual instead of $($entry.Value)."
    }
  }
  $expectedFlags = @{
    StrictOnline = 0x2080
    OfflineBaseline = 0x3010
    OfflineRevocation = 0x3080
  }
  foreach ($entry in $expectedFlags.GetEnumerator()) {
    $purpose = [Enum]::Parse($purposeType, $entry.Key)
    $actual = [uint32]$providerFlags.Invoke($null, [object[]]@($purpose))
    if ($actual -ne [uint32]$entry.Value) {
      throw "$fileName returned WinTrust flags 0x$($actual.ToString('X')) for $($entry.Key), expected 0x$(([uint32]$entry.Value).ToString('X'))."
    }
  }

  $releaseSecurityType = $assembly.GetType('ArcaneOS.ReleaseSecurityVerifier', $true)
  $continuity = $releaseSecurityType.GetMethod('EvaluatePublisherContinuityPolicy', $staticFlags)
  $validateDegradedTime = $releaseSecurityType.GetMethod('ValidateDegradedVerificationTime', $staticFlags)
  $capDegradedDelay = $releaseSecurityType.GetMethod('CapDegradedRetryDelay', $staticFlags)
  $assertRegistry = $releaseSecurityType.GetMethod('AssertAdminControlledRegistry', $staticFlags)
  $assertLegacyAcl = $releaseSecurityType.GetMethod('AssertLegacyAdminControlled', $staticFlags)
  $legacyEvidence = $releaseSecurityType.GetMethod('EvaluateLegacyInstalledPublisherEvidence', $staticFlags)
  if (-not $continuity -or -not $validateDegradedTime -or -not $capDegradedDelay -or -not $assertRegistry -or
      -not $assertLegacyAcl -or -not $legacyEvidence) {
    throw "$fileName does not expose the publisher-continuity hardening probes."
  }

  $attestationNow = [DateTimeOffset]::new(2030, 6, 1, 12, 0, 0, [TimeSpan]::Zero)
  $recentAttestation = Format-UtcTimestamp($attestationNow.AddDays(-29))
  $expiryArguments = New-Object object[] 2
  $expiryArguments[0] = $recentAttestation
  $expiryArguments[1] = $attestationNow
  $expiry = [DateTimeOffset]$validateDegradedTime.Invoke($null, $expiryArguments)
  if ($expiry -ne $attestationNow.AddDays(1)) {
    throw "$fileName did not calculate the immutable 30-day publisher-attestation deadline."
  }
  Assert-ReflectionThrows "$fileName expired publisher attestation" ([IO.InvalidDataException]) `
    'Arcane publisher attestation has expired during degraded verification.' {
      $arguments = New-Object object[] 2
      $arguments[0] = Format-UtcTimestamp($attestationNow.AddDays(-30))
      $arguments[1] = $attestationNow
      $validateDegradedTime.Invoke($null, $arguments)
    }
  Assert-ReflectionThrows "$fileName future publisher attestation" ([IO.InvalidDataException]) `
    'Arcane publisher attestation has an invalid verification time.' {
      $arguments = New-Object object[] 2
      $arguments[0] = Format-UtcTimestamp($attestationNow.AddMinutes(6))
      $arguments[1] = $attestationNow
      $validateDegradedTime.Invoke($null, $arguments)
    }
  Assert-ReflectionThrows "$fileName non-canonical publisher timestamp" ([IO.InvalidDataException]) `
    'Arcane publisher attestation has an invalid verification time.' {
      $arguments = New-Object object[] 2
      $arguments[0] = '2030-05-03T12:00:00.0000000+00:00'
      $arguments[1] = $attestationNow
      $validateDegradedTime.Invoke($null, $arguments)
    }
  $nearDeadline = Format-UtcTimestamp($attestationNow.AddDays(-30).AddMinutes(15))
  $delayArguments = New-Object object[] 3
  $delayArguments[0] = $nearDeadline
  $delayArguments[1] = $attestationNow
  $delayArguments[2] = [TimeSpan]::FromHours(1)
  $cappedDelay = [TimeSpan]$capDegradedDelay.Invoke($null, $delayArguments)
  if ($cappedDelay -ne [TimeSpan]::FromMinutes(15)) {
    throw "$fileName allowed a degraded-verification retry to cross the attestation deadline."
  }
  $delayArguments[2] = [TimeSpan]::FromMinutes(5)
  $unchangedDelay = [TimeSpan]$capDegradedDelay.Invoke($null, $delayArguments)
  if ($unchangedDelay -ne [TimeSpan]::FromMinutes(5)) {
    throw "$fileName changed a degraded-verification retry that already fits before the deadline."
  }
  Assert-ReflectionThrows "$fileName zero degraded retry delay" ([ArgumentOutOfRangeException]) $null {
    $arguments = New-Object object[] 3
    $arguments[0] = $nearDeadline
    $arguments[1] = $attestationNow
    $arguments[2] = [TimeSpan]::Zero
    $capDegradedDelay.Invoke($null, $arguments)
  }

  $safeRegistry = New-Object Security.AccessControl.RegistrySecurity
  $safeRegistry.SetSecurityDescriptorSddlForm('O:BAG:SYD:AI(A;CIIO;KA;;;CO)(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;CI;KR;;;BU)')
  $null = Invoke-SecurityProbe $assertRegistry $safeRegistry 'publisher policy test'
  $badOwnerRegistry = New-Object Security.AccessControl.RegistrySecurity
  $badOwnerRegistry.SetSecurityDescriptorSddlForm('O:BUG:SYD:AI(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;CI;KR;;;BU)')
  Assert-ReflectionThrows "$fileName user-owned publisher policy" ([IO.InvalidDataException]) `
    'Arcane publisher policy test registry ownership or DACL is invalid.' {
      Invoke-SecurityProbe $assertRegistry $badOwnerRegistry 'publisher policy test'
    }
  $userWritableRegistry = New-Object Security.AccessControl.RegistrySecurity
  $userWritableRegistry.SetSecurityDescriptorSddlForm('O:BAG:SYD:AI(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;CI;KW;;;BU)')
  Assert-ReflectionThrows "$fileName user-writable publisher policy" ([IO.InvalidDataException]) `
    'Arcane publisher policy test registry grants write access to an untrusted identity.' {
      Invoke-SecurityProbe $assertRegistry $userWritableRegistry 'publisher policy test'
    }
  $effectiveCreatorOwnerRegistry = New-Object Security.AccessControl.RegistrySecurity
  $effectiveCreatorOwnerRegistry.SetSecurityDescriptorSddlForm('O:BAG:SYD:AI(A;CI;KA;;;CO)(A;CI;KA;;;SY)(A;CI;KA;;;BA)')
  Assert-ReflectionThrows "$fileName effective Creator Owner publisher mutation" ([IO.InvalidDataException]) `
    'Arcane publisher policy test registry grants write access to an untrusted identity.' {
      Invoke-SecurityProbe $assertRegistry $effectiveCreatorOwnerRegistry 'publisher policy test'
    }
  $createLinkRegistry = New-Object Security.AccessControl.RegistrySecurity
  $createLinkRegistry.SetSecurityDescriptorSddlForm('O:BAG:SYD:AI(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;;0x00000020;;;BU)')
  Assert-ReflectionThrows "$fileName user CreateLink publisher mutation" ([IO.InvalidDataException]) `
    'Arcane publisher policy test registry grants write access to an untrusted identity.' {
      Invoke-SecurityProbe $assertRegistry $createLinkRegistry 'publisher policy test'
    }

  $trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  $safeLegacyAcl = New-Object Security.AccessControl.DirectorySecurity
  $safeLegacyAcl.SetSecurityDescriptorSddlForm("O:${trustedInstaller}G:SYD:AI(A;OICIIO;FA;;;CO)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;BU)")
  $null = Invoke-SecurityProbe $assertLegacyAcl $safeLegacyAcl 'legacy test'
  $badOwnerLegacyAcl = New-Object Security.AccessControl.DirectorySecurity
  $badOwnerLegacyAcl.SetSecurityDescriptorSddlForm('O:BUG:SYD:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;BU)')
  Assert-ReflectionThrows "$fileName user-owned legacy tree" ([IO.InvalidDataException]) `
    'Arcane legacy test legacy ownership or DACL is invalid.' {
      Invoke-SecurityProbe $assertLegacyAcl $badOwnerLegacyAcl 'legacy test'
    }
  $userWritableLegacyAcl = New-Object Security.AccessControl.DirectorySecurity
  $userWritableLegacyAcl.SetSecurityDescriptorSddlForm('O:BAG:SYD:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FW;;;BU)')
  Assert-ReflectionThrows "$fileName user-writable legacy tree" ([IO.InvalidDataException]) `
    'Arcane legacy test legacy ACL grants mutation rights to an untrusted identity.' {
      Invoke-SecurityProbe $assertLegacyAcl $userWritableLegacyAcl 'legacy test'
    }
  $effectiveCreatorOwnerLegacyAcl = New-Object Security.AccessControl.DirectorySecurity
  $effectiveCreatorOwnerLegacyAcl.SetSecurityDescriptorSddlForm('O:BAG:SYD:AI(A;OICI;FA;;;CO)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  Assert-ReflectionThrows "$fileName effective Creator Owner legacy mutation" ([IO.InvalidDataException]) `
    'Arcane legacy test legacy ACL grants mutation rights to an untrusted identity.' {
      Invoke-SecurityProbe $assertLegacyAcl $effectiveCreatorOwnerLegacyAcl 'legacy test'
  }

  $signatureStatusType = $assembly.GetType('ArcaneOS.SignatureStatus', $true)
  $oldSigner = 'A' * 40
  $newSigner = 'B' * 40
  $matchingSigned = New-EnumVector $signatureStatusType @('Valid', 'Valid')
  $signedPin = [string](Invoke-LegacyEvidence $legacyEvidence $matchingSigned ([string[]]@($oldSigner, $oldSigner)) ([bool[]]@($true, $true)))
  if ($signedPin -ne $oldSigner) { throw "$fileName did not derive a matching signed legacy publisher pin." }
  $matchingUnsigned = New-EnumVector $signatureStatusType @('NotSigned', 'NotSigned')
  $unsignedPin = Invoke-LegacyEvidence $legacyEvidence $matchingUnsigned ([string[]]@($null, $null)) ([bool[]]@($false, $false))
  if ($null -ne $unsignedPin) { throw "$fileName derived publisher continuity from an all-unsigned legacy installation." }
  $mixedEvidence = New-EnumVector $signatureStatusType @('Valid', 'NotSigned')
  Assert-ReflectionThrows "$fileName mixed signed legacy evidence" ([IO.InvalidDataException]) `
    'Arcane legacy installation mixes signed and unsigned executables.' {
      Invoke-LegacyEvidence $legacyEvidence $mixedEvidence ([string[]]@($oldSigner, $null)) ([bool[]]@($true, $false))
    }
  $differentSigners = New-EnumVector $signatureStatusType @('Valid', 'Valid')
  Assert-ReflectionThrows "$fileName divergent legacy publishers" ([IO.InvalidDataException]) `
    'Arcane legacy installation contains executables from different publishers.' {
      Invoke-LegacyEvidence $legacyEvidence $differentSigners ([string[]]@($oldSigner, $newSigner)) ([bool[]]@($true, $true))
    }
  Assert-ReflectionThrows "$fileName untimestamped legacy publisher" ([IO.InvalidDataException]) `
    'Arcane legacy publisher evidence contains an untimestamped signature.' {
      Invoke-LegacyEvidence $legacyEvidence $matchingSigned ([string[]]@($oldSigner, $oldSigner)) ([bool[]]@($true, $false))
    }
  Assert-ReflectionThrows "$fileName malformed unsigned legacy evidence" ([IO.InvalidDataException]) `
    'Arcane legacy unsigned evidence contains unexpected signer material.' {
      Invoke-LegacyEvidence $legacyEvidence $matchingUnsigned ([string[]]@($null, $oldSigner)) ([bool[]]@($false, $false))
    }
  $untrustedEvidence = New-EnumVector $signatureStatusType @('RevocationUnavailable')
  Assert-ReflectionThrows "$fileName unavailable legacy verification" ([IO.InvalidDataException]) `
    'Arcane could not establish legacy installed publisher continuity from RevocationUnavailable evidence.' {
      Invoke-LegacyEvidence $legacyEvidence $untrustedEvidence ([string[]]@($null)) ([bool[]]@($false))
    }

  $rotation = [string]$continuity.Invoke($null, [object[]]@($newSigner,$oldSigner,$newSigner,$oldSigner,1,$true,$true))
  if ($rotation -ne 'administrator-policy-rotation') { throw "$fileName did not accept an explicit matching publisher rotation policy." }
  $rejectedRotation = $false
  try { $null = $continuity.Invoke($null, [object[]]@($newSigner,$oldSigner,$newSigner,('C' * 40),1,$true,$true)) }
  catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    if ($cause -isnot [IO.InvalidDataException] -or $cause.Message -ne 'Arcane administrator publisher policy conflicts with the protected installed pin and has no valid rotation authorization.') { throw }
    $rejectedRotation = $true
  }
  if (-not $rejectedRotation) { throw "$fileName accepted a publisher rotation whose predecessor did not match the installed pin." }

  $authenticodeProbeType = $assembly.GetType('ArcaneOS.AuthenticodeProbe', $true)
  $runBoundedProcess = $authenticodeProbeType.GetMethod('RunBoundedProcess', $staticFlags)
  if (-not $runBoundedProcess) { throw "$fileName does not expose the bounded Authenticode worker probe." }
  $sleeperExecutable = (Get-Process -Id $PID).Path
  if (-not $sleeperExecutable -or ([IO.Path]::GetFileName($sleeperExecutable) -notmatch '^(powershell|pwsh)[.]exe$')) {
    throw "$fileName cannot locate a PowerShell executable for the bounded-worker cleanup test."
  }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $sleeperExecutable
  $start.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $boundedArguments = New-Object object[] 2
  $boundedArguments[0] = $start
  $boundedArguments[1] = [TimeSpan]::FromMilliseconds(500)
  $boundedClock = [Diagnostics.Stopwatch]::StartNew()
  $boundedResult = $runBoundedProcess.Invoke($null, $boundedArguments)
  $boundedClock.Stop()
  $resultType = $boundedResult.GetType()
  $timedOut = [bool]$resultType.GetProperty('TimedOut', $bindingFlags).GetValue($boundedResult, $null)
  $boundedExitCode = [int]$resultType.GetProperty('ExitCode', $bindingFlags).GetValue($boundedResult, $null)
  $boundedProcessId = [int]$resultType.GetProperty('ProcessId', $bindingFlags).GetValue($boundedResult, $null)
  if (-not $timedOut -or $boundedExitCode -ne -1 -or $boundedClock.Elapsed -gt [TimeSpan]::FromSeconds(10)) {
    throw "$fileName did not enforce the Authenticode worker timeout bound."
  }
  try {
    $survivor = [Diagnostics.Process]::GetProcessById($boundedProcessId)
    $survivor.Dispose()
    throw "$fileName returned before the timed-out Authenticode worker was reaped."
  }
  catch [ArgumentException] { }

  Write-Host "$fileName exposes ArcaneBridge.Send through IDispatch (DISPID $dispatchId)."
}

Write-Host 'Windows WebView2 bridge COM dispatch verification passed.'
