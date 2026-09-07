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
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class MonkexWindows {
  public delegate bool Visitor(IntPtr hwnd, IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visit, IntPtr arg);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int count);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  public static Dictionary<IntPtr,string> Visible(int target) {
    var found = new Dictionary<IntPtr,string>();
    EnumWindows((hwnd, arg) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid == target && IsWindowVisible(hwnd)) {
        var title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity);
        found[hwnd] = title.ToString();
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$process = Start-Process -FilePath $app -PassThru
$window = [IntPtr]::Zero
try {
  $deadline = (Get-Date).AddSeconds(65)
  do {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) { throw "Desktop application exited: $($process.ExitCode)" }
    $visible = [MonkexWindows]::Visible($process.Id)
    foreach ($entry in $visible.GetEnumerator()) {
      if ($entry.Value -eq 'Monkex') { $window = $entry.Key; break }
    }
  } until ($window -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($window -eq [IntPtr]::Zero) {
    throw "Visible Monkex window did not appear. Observed titles: $($visible.Values -join ', '); MainWindowTitle: $($process.MainWindowTitle)"
  }
  $health = Invoke-RestMethod http://127.0.0.1:8766/api/health
  if ($health.app_server -ne 'offline' -or $health.shell_task_count -ne 0) { throw 'Clean startup state mismatch' }
  Write-Output 'PASS: NSIS installation, bundled Python/web resources, clean offline startup and real Monkex native window'
} finally {
  if (!$process.HasExited) {
    if ($window -ne [IntPtr]::Zero) { $null = [MonkexWindows]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    if (!$process.WaitForExit(5000)) { Stop-Process -Id $process.Id -Force }
  }
}
$leaked = $false
try { $null = Invoke-RestMethod http://127.0.0.1:8766/api/health -TimeoutSec 2; $leaked = $true } catch {}
if ($leaked) { throw 'Backend remained alive after application exit' }
Write-Output 'PASS: exit releases the owned backend and loopback port'
