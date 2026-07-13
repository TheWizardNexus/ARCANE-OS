param()

$ErrorActionPreference = 'Stop'
$runtime = 'C:\Program Files\Ollama'
$result = 'C:\ProgramData\Arcane OS\cache\ollama\standard-read-acl.txt'
& "$env:SystemRoot\System32\icacls.exe" $runtime /grant:r '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE." }
'applied' | Set-Content -LiteralPath $result -Encoding ASCII
