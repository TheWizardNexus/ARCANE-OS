$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $root 'dist'
$target = Join-Path $distRoot 'windows'
$stage = Join-Path $distRoot ".windows.stage-$PID"
$backup = Join-Path $distRoot ".windows.backup-$PID"
$pkg = Join-Path $root 'node_modules\.bin\pkg.cmd'
$runtime = Join-Path $root 'runtime\arcane-core.cjs'
$generatedApp = Join-Path $distRoot 'app'
$generatedBundle = Join-Path $distRoot 'arcane-bundle.json'

foreach ($candidate in @($target, $stage, $backup)) {
  $resolvedParent = [IO.Path]::GetFullPath((Split-Path -Parent $candidate)).TrimEnd('\')
  $expectedParent = [IO.Path]::GetFullPath($distRoot).TrimEnd('\')
  if ($resolvedParent -ne $expectedParent) { throw "Refusing to build outside $expectedParent." }
}
if (-not (Test-Path -LiteralPath $pkg)) { throw 'The pinned pkg build tool is missing. Run npm ci first.' }
if (-not (Test-Path -LiteralPath $runtime)) { throw 'The generated Arcane Core is missing. Run npm run build first.' }
if (-not (Test-Path -LiteralPath $generatedApp) -or -not (Test-Path -LiteralPath $generatedBundle)) {
  throw 'The generated Arcane application payload is missing. Run npm run build first.'
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

$movedExisting = $false
try {
  Copy-Item -LiteralPath $generatedApp -Destination (Join-Path $stage 'app') -Recurse
  Copy-Item -LiteralPath $generatedBundle -Destination (Join-Path $stage 'arcane-bundle.json')

  & $pkg $runtime '--targets' 'node22-win-x64' '--output' (Join-Path $stage 'ArcaneCore.exe')
  if ($LASTEXITCODE -ne 0) { throw "Packaging ArcaneCore.exe failed with exit code $LASTEXITCODE." }

  & (Join-Path $root 'tools\build-windows-webview2.ps1') -Dist $stage
  if ($LASTEXITCODE -ne 0) { throw "Building the WebView2 hosts failed with exit code $LASTEXITCODE." }

  if (Test-Path -LiteralPath $target) {
    Move-Item -LiteralPath $target -Destination $backup
    $movedExisting = $true
  }
  Move-Item -LiteralPath $stage -Destination $target
  if ($movedExisting -and (Test-Path -LiteralPath $backup)) {
    Remove-Item -LiteralPath $backup -Recurse -Force
  }
  Write-Host "Atomic Windows release published to $target"
} catch {
  if (-not (Test-Path -LiteralPath $target) -and $movedExisting -and (Test-Path -LiteralPath $backup)) {
    Move-Item -LiteralPath $backup -Destination $target
  }
  throw
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
