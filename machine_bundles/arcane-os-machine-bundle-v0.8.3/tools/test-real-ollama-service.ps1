param(
  [Parameter(Mandatory = $true)][string]$CompiledServiceHost,
  [Parameter(Mandatory = $true)][string]$RealOllamaExecutable
)

$ErrorActionPreference = 'Stop'
$serviceName = 'ArcaneOllama'
$runtime = 'C:\Program Files\Ollama'
$serviceHost = Join-Path $runtime 'ArcaneOllamaService.exe'
$ollama = Join-Path $runtime 'ollama.exe'
$models = 'C:\ProgramData\Arcane OS\ollama-models'
$diagnosticRoot = 'C:\ProgramData\Arcane OS\cache\ollama'
$diagnosticFile = Join-Path $diagnosticRoot 'real-service-test.json'
$result = [ordered]@{
  startedAt = [DateTime]::UtcNow.ToString('o')
  passed = $false
  service = $serviceName
  runtime = $runtime
  sourceOllama = $RealOllamaExecutable
  serviceHost = $CompiledServiceHost
  configuration = $null
  state = $null
  api = $null
  error = $null
}

function Invoke-Sc([string[]]$Arguments, [switch]$AllowFailure) {
  $lines = @(& "$env:SystemRoot\System32\sc.exe" @Arguments 2>&1 | ForEach-Object { $_.ToString() })
  $code = $LASTEXITCODE
  $text = ($lines -join "`r`n").Trim()
  if ($code -ne 0 -and -not $AllowFailure) { throw "sc.exe $($Arguments[0]) failed ($code).`r`n$text" }
  return [pscustomobject]@{ ExitCode = $code; Text = $text }
}

function Wait-State([string]$Expected, [int]$Milliseconds) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($Milliseconds)
  do {
    $query = Invoke-Sc @('query', $serviceName) -AllowFailure
    if ($Expected -eq 'running' -and $query.ExitCode -eq 0 -and $query.Text -match 'STATE\s*:\s*4\s+RUNNING') { return $query.Text }
    if ($Expected -eq 'stopped' -and $query.ExitCode -eq 0 -and $query.Text -match 'STATE\s*:\s*1\s+STOPPED') { return $query.Text }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "ArcaneOllama did not become $Expected in $Milliseconds ms.`r`n$($query.Text)"
}

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator approval was not granted.' }
  foreach ($path in @($CompiledServiceHost, $RealOllamaExecutable)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required real-service test file is missing: $path" }
  }

  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  New-Item -ItemType Directory -Path $models -Force | Out-Null
  New-Item -ItemType Directory -Path $diagnosticRoot -Force | Out-Null

  $existing = Invoke-Sc @('query', $serviceName) -AllowFailure
  if ($existing.ExitCode -eq 0) {
    Invoke-Sc @('stop', $serviceName) -AllowFailure | Out-Null
    try { Wait-State 'stopped' 5000 | Out-Null } catch { }
  }

  Copy-Item -LiteralPath $CompiledServiceHost -Destination $serviceHost -Force
  if ((-not (Test-Path -LiteralPath $ollama -PathType Leaf)) -or ((Get-Item -LiteralPath $ollama).Length -ne (Get-Item -LiteralPath $RealOllamaExecutable).Length)) {
    Copy-Item -LiteralPath $RealOllamaExecutable -Destination $ollama -Force
  }

  & "$env:SystemRoot\System32\icacls.exe" $runtime /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Applying the real ArcaneOllama runtime ACL failed.' }

  $imagePath = '"' + $serviceHost + '"'
  if ($existing.ExitCode -eq 0) {
    Invoke-Sc @('config', $serviceName, 'binPath=', $imagePath, 'start=', 'auto', 'obj=', 'NT AUTHORITY\LocalService') | Out-Null
  } else {
    Invoke-Sc @('create', $serviceName, 'binPath=', $imagePath, 'start=', 'auto', 'obj=', 'NT AUTHORITY\LocalService', 'DisplayName=', 'Arcane Ollama Service') | Out-Null
    Invoke-Sc @('description', $serviceName, 'Arcane-managed Ollama runtime for Arcane OS users') | Out-Null
  }
  Invoke-Sc @('sidtype', $serviceName, 'unrestricted') | Out-Null

  $serviceKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\ArcaneOllama'
  New-ItemProperty -Path $serviceKey -Name Environment -PropertyType MultiString -Value @("OLLAMA_MODELS=$models", 'OLLAMA_HOST=127.0.0.1:11434') -Force | Out-Null
  $eventKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\ArcaneOllama'
  New-Item -Path $eventKey -Force | Out-Null
  $messageDll = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'EventLogMessages.dll'
  New-ItemProperty -Path $eventKey -Name EventMessageFile -PropertyType ExpandString -Value $messageDll -Force | Out-Null
  New-ItemProperty -Path $eventKey -Name TypesSupported -PropertyType DWord -Value 7 -Force | Out-Null

  $result.configuration = (Invoke-Sc @('qc', $serviceName)).Text
  Invoke-Sc @('start', $serviceName) | Out-Null
  $result.state = Wait-State 'running' 8000
  $response = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -Method Get -TimeoutSec 5
  $result.api = $response
  $result.passed = $true
}
catch {
  $result.error = $_.Exception.Message
  $result.state = (Invoke-Sc @('query', $serviceName) -AllowFailure).Text
  if (-not $result.configuration) { $result.configuration = (Invoke-Sc @('qc', $serviceName) -AllowFailure).Text }
}
finally {
  $result.finishedAt = [DateTime]::UtcNow.ToString('o')
  New-Item -ItemType Directory -Path $diagnosticRoot -Force | Out-Null
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $diagnosticFile -Encoding UTF8
}

if (-not $result.passed) {
  Write-Error "ArcaneOllama real-service test failed. Runtime and service were preserved. Diagnostic: $diagnosticFile"
  exit 1
}

Write-Host "ArcaneOllama real-service test passed. Diagnostic: $diagnosticFile"
