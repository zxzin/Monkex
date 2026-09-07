$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem desktop_shell/src-tauri/target/release/bundle/nsis/*-setup.exe | Select-Object -First 1
if (!$installer) { throw 'Installer missing' }
$installDir = Join-Path $env:RUNNER_TEMP 'Monkex-installed'
$setup = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
$backend = Join-Path $installDir 'monkex-backend.exe'
$app = Join-Path $installDir 'zinx-work-twin.exe'
if (!(Test-Path $backend) -or !(Test-Path $app)) { throw 'Installed executables missing' }
python scripts/smoke_monkex_backend.py $backend (Join-Path $installDir 'web')
if ($LASTEXITCODE -ne 0) { throw 'Installed backend smoke failed' }
$env:MONKEX_CODEX_PATH = Join-Path $installDir 'missing-codex-for-smoke.exe'
$env:MONKEX_AI_SUMMARIES = '0'
$process = Start-Process -FilePath $app -PassThru
try {
  $deadline = (Get-Date).AddSeconds(65)
  do {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) { throw "Desktop application exited: $($process.ExitCode)" }
  } until ($process.MainWindowHandle -ne 0 -or (Get-Date) -gt $deadline)
  if ($process.MainWindowHandle -eq 0) { throw 'Desktop window did not appear' }
  if ($process.MainWindowTitle -ne 'Monkex') { throw 'Unexpected window title' }
  $health = Invoke-RestMethod http://127.0.0.1:8766/api/health
  if ($health.app_server -ne 'offline' -or $health.shell_task_count -ne 0) { throw 'Clean startup state mismatch' }
  Write-Output 'PASS: NSIS installation, bundled Python/web resources, clean offline startup and real Monkex native window'
} finally {
  if (!$process.HasExited) {
    $null = $process.CloseMainWindow()
    if (!$process.WaitForExit(5000)) { Stop-Process -Id $process.Id -Force }
  }
}
$leaked = $false
try { $null = Invoke-RestMethod http://127.0.0.1:8766/api/health -TimeoutSec 2; $leaked = $true } catch {}
if ($leaked) { throw 'Backend remained alive after application exit' }
Write-Output 'PASS: exit releases the owned backend and loopback port'
