# dsh-restart — restart the DeepSeek Harness desktop app on Windows.
#
# WHY THIS SCRIPT IS TWO PHASES (read before changing anything)
# ------------------------------------------------------------
# Every DSH process (shell, host, renderer, GPU, utility, subprocess runner) lives in a
# Windows job object created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000), and a child
# spawned the ordinary way INHERITS that job. Measured with a controlled surrogate on
# 2026-10-06: a fake shell was put in a kill-on-close job, spawned three workers, then the
# job handle was closed:
#
#   plain      (Start-Process)         19 beats, last 14:31:32.640 -> killed by the job
#   wmi        (Win32_Process.Create)  50 beats, last 14:31:45.402 -> survived (+13 s)
#   explorer   (explorer.exe file.cmd) 50 beats, last 14:31:46.105 -> survived (+13 s)
#
# The job closed at 14:31:32.941 and the plain worker stopped 0.3 s BEFORE it. So a worker
# started with Start-Process can never relaunch anything: it dies at the exact moment the
# app dies.
#
#   => Phase 1 (no -Worker): resolve the app, hand the work to a process that is NOT in the
#      job, via Invoke-CimMethod Win32_Process Create (fallback: explorer.exe + a .cmd),
#      write the "launched" result and EXIT immediately without waiting.
#   => Phase 2 (-Worker): the escaped process does the work: grace delay, terminate ONLY the
#      root shell, wait for the app's process set to leave, wait for the port to free, start
#      the app, raise its window, write the terminal result.
#
# WHY ONLY THE ROOT SHELL IS TERMINATED
# -------------------------------------
# The Electron browser process ("the shell") is the root of the app's process set. When it
# dies, the host is shut down GRACEFULLY by its own IPC-disconnect handler
# (dsh-desktop-host/lib/index.js:320 -> shutdown.shutdown(0), with a 5 s force-exit bound),
# and the Chromium children go with their parent. Killing the HOST directly makes the shell
# show a fatal recovery dialog, so it is never done here.
#
# SINGLE-INSTANCE GUARD ORDER
# ---------------------------
# The shell holds requestSingleInstanceLock(), so starting a second instance too early just
# focuses the old window and exits. Therefore: wait for the old SHELL pid to disappear, then
# for the port to stop listening, and only then start the new instance.
#
# COMPATIBILITY
# -------------
# Must parse and run on Windows PowerShell 5.1 and PowerShell 7. No ternary `?:`, no `??`,
# no `-and`/`-or` chain tricks, no ::new() on types 5.1 does not have. The source is pure
# ASCII on purpose: Windows PowerShell 5.1 decodes .ps1 files with the ANSI code page (GBK
# here), so a CJK literal could be mis-decoded.
#
# Exit codes: 0 launched / would-restart / not-running / restarted / quit-only,
#             3 quit-timeout, 4 app-not-found, 5 start-failed, 6 already-running.

[CmdletBinding()]
param(
  # Resolve and report only: terminate nothing, start nothing, hand off nothing.
  [switch] $DryRun,

  # Print one compact JSON line on stdout (the plugin parses this).
  [switch] $Json,

  # Where the terminal result JSON is written (UTF-8, no BOM), before this process exits.
  # The plugin polls this file: phase 1's caller dies with the app it restarts.
  [string] $ResultPath = '',

  # Quit the app and stop there, without relaunching it.
  [switch] $QuitOnly,

  # How long the escaped worker waits for the whole app process set to leave.
  [int] $QuitTimeoutSeconds = 45,

  # How long the escaped worker waits for the relaunched app to own a window.
  [int] $StartTimeoutSeconds = 90,

  # Delay before anything is terminated, so the caller's command result can render in the
  # UI while the app is still alive.
  [double] $GraceSeconds = 2.5,

  # TCP port that must stop listening before the app is started again.
  [int] $Port = 19387,

  # Explicit executable path. When empty, the app is auto-detected (contract section 6).
  [string] $AppPath = '',

  # Internal: this invocation is already the escaped worker. Set by the phase-1 handoff.
  [switch] $Worker,

  # Permit force-killing the survivors of a quit timeout. WITHOUT this switch a quit timeout
  # kills nothing beyond the root shell and ends in status `quit-timeout`.
  [switch] $AllowForce,

  # Internal: bypass the single-worker guard. Only for tests that deliberately drive two
  # handoffs at once; never passed by the plugin.
  [switch] $SkipWorkerGuard
)

# UTF-8 on stdout/stderr regardless of the machine's ANSI code page. Measured bug: without
# this, redirected output came back as GBK mojibake.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

# Version 2.0 behaves identically on 5.1 and 7 (Latest resolves to 3.0 on 7 and 2.0 on 5.1).
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ── script state (shared with the helpers below) ───────────────────────────────────────────
$script:startedAt = Get-Date
$script:notes = New-Object System.Collections.Generic.List[string]
$script:resolvedAppPath = ''
$script:resolvedExeName = ''
$script:shellPids = @()
$script:allPids = @()
$script:newShellPid = 0
$script:raised = $false
$script:phase = 'resolve'          # 'resolve' | 'quit' | 'start' — maps unexpected errors
$script:netTcpChecked = $false
$script:netTcpAvailable = $false
$script:foregroundApiChecked = $false
$script:foregroundApiReady = $false
$script:foregroundApiError = ''

# ── reporting ──────────────────────────────────────────────────────────────────────────────

<#
.SYNOPSIS
  Record a progress line (kept for the JSON notes, printed only in human mode).
#>
function Write-Note {
  param([Parameter(Mandatory)][string] $Message)
  [void]$script:notes.Add($Message)
  if (-not $Json) { Write-Host $Message }
}

<#
.SYNOPSIS
  Write the result JSON as UTF-8 WITHOUT a BOM.
.DESCRIPTION
  The caller of phase 1 is the app being restarted, so its stdout pipe can vanish; this file
  is the durable copy and is written before the process exits on every path.
#>
function Write-ResultFile {
  param([string] $Path, [string] $Text)

  if (-not $Path) { return $false }
  try {
    $folder = Split-Path -Parent $Path
    if ($folder -and -not (Test-Path -LiteralPath $folder)) {
      New-Item -ItemType Directory -Force -Path $folder | Out-Null
    }
  } catch { }
  try {
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
    return $true
  } catch {
    return $false
  }
}

<#
.SYNOPSIS
  Emit the terminal result (file + stdout) and exit with the matching code.
#>
function Complete-Run {
  param(
    [Parameter(Mandatory)][string] $Status,
    [Parameter(Mandatory)][int] $Code,
    [string] $Detail = ''
  )

  $payload = [pscustomobject][ordered]@{
    status      = $Status
    detail      = $Detail
    code        = $Code
    at          = (Get-Date).ToString('o')
    appPath     = $script:resolvedAppPath
    exeName     = $script:resolvedExeName
    shellPids   = @($script:shellPids)
    allPids     = @($script:allPids)
    newShellPid = [int]$script:newShellPid
    port        = [int]$Port
    raised      = [bool]$script:raised
    durationMs  = [int]((Get-Date) - $script:startedAt).TotalMilliseconds
    notes       = @($script:notes)
  }

  $json = $payload | ConvertTo-Json -Depth 4 -Compress
  if ($ResultPath) {
    if (-not (Write-ResultFile -Path $ResultPath -Text $json)) {
      [void]$script:notes.Add("could not write the result file: $ResultPath")
    }
  }
  if ($Json) { Write-Output $json } elseif ($Detail -ne '') { Write-Host $Detail }
  exit $Code
}

# ── app resolution (contract section 6) ────────────────────────────────────────────────────

<#
.SYNOPSIS
  Known install locations, in the contract's order.
#>
function Get-DefaultAppPaths {
  # 'C:\agent\新建文件夹\DeepSeek Harness.exe' — built from code points so this file stays
  # pure ASCII and cannot be mis-decoded by Windows PowerShell 5.1 (see the header).
  $cjkFolder = ([string][char]0x65B0) + ([string][char]0x5EFA) + ([string][char]0x6587) + ([string][char]0x4EF6)
  $candidates = @(
    'C:\agent\dsh_desktop\DeepSeek Harness.exe',
    ('C:\agent\' + $cjkFolder + '\DeepSeek Harness.exe')
  )
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\@deepseek-aidsh-desktop\DeepSeek Harness.exe')
  }
  return $candidates
}

<#
.SYNOPSIS
  Resolve the desktop shell executable.
.OUTPUTS
  An absolute path, or '' when the app cannot be found.
#>
function Resolve-AppPath {
  param([string] $Explicit)

  # 1. Explicit path wins; it must exist, otherwise this is an app-not-found.
  if ($Explicit) {
    try {
      if (Test-Path -LiteralPath $Explicit -PathType Leaf) { return (Resolve-Path -LiteralPath $Explicit).Path }
    } catch { }
    return ''
  }

  # 2. Environment override.
  if ($env:DSH_DESKTOP_APP_PATH) {
    try {
      if (Test-Path -LiteralPath $env:DSH_DESKTOP_APP_PATH -PathType Leaf) {
        return (Resolve-Path -LiteralPath $env:DSH_DESKTOP_APP_PATH).Path
      }
    } catch { }
  }

  # 3. The parent process. The plugin passes -AppPath computed from process.ppid, so this is
  #    only the fallback for a manual run from a shell the app itself started.
  try {
    $me = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
    if ($me) {
      $parent = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + [int]$me.ParentProcessId) -ErrorAction Stop
      if ($parent -and $parent.ExecutablePath) {
        $parentExe = [string]$parent.ExecutablePath
        $parentName = [System.IO.Path]::GetFileNameWithoutExtension($parentExe)
        if ($parentName -eq 'DeepSeek Harness' -and (Test-Path -LiteralPath $parentExe -PathType Leaf)) {
          return $parentExe
        }
      }
    }
  } catch { }

  # 4. Known locations.
  foreach ($candidate in (Get-DefaultAppPaths)) {
    try {
      if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    } catch { }
  }
  return ''
}

# ── the app's process set (contract section 4) ─────────────────────────────────────────────

<#
.SYNOPSIS
  Every live process whose image path is the resolved executable.
.DESCRIPTION
  Win32_Process is used because it exposes ParentProcessId AND ExecutablePath in one query.
  A process whose ExecutablePath is unreadable is matched by name only (contract fallback).
.OUTPUTS
  Objects with Pid / ParentPid / Name / MainWindow.
#>
function Get-AppProcessSnapshot {
  param([Parameter(Mandatory)][string] $Path)

  $name = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $items = New-Object System.Collections.ArrayList
  $rows = $null
  $haveRows = $false

  try {
    $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$name.exe'" -ErrorAction Stop)
    $haveRows = $true
  } catch {
    try {
      $rows = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq "$name.exe" })
      $haveRows = $true
    } catch {
      $haveRows = $false
    }
  }

  if ($haveRows) {
    foreach ($row in $rows) {
      $exe = ''
      try { $exe = [string]$row.ExecutablePath } catch { $exe = '' }
      if ($exe -ne '' -and -not [string]::Equals($exe, $Path, [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
      }
      $window = [int64]0
      try { $window = [int64](Get-Process -Id ([int]$row.ProcessId) -ErrorAction Stop).MainWindowHandle } catch { $window = [int64]0 }
      [void]$items.Add([pscustomobject]@{
        Pid        = [int]$row.ProcessId
        ParentPid  = [int]$row.ParentProcessId
        Name       = [string]$row.Name
        MainWindow = $window
      })
    }
    return @($items.ToArray())
  }

  # Last resort without CIM: name-matched processes, parent unknown (0). Every member then
  # looks like a root, and the window-owner preference below still finds the shell.
  foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
    $exe = ''
    try { $exe = [string]$proc.Path } catch { $exe = '' }
    if ($exe -ne '' -and -not [string]::Equals($exe, $Path, [System.StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    [void]$items.Add([pscustomobject]@{
      Pid        = [int]$proc.Id
      ParentPid  = 0
      Name       = [string]$proc.ProcessName
      MainWindow = [int64]$proc.MainWindowHandle
    })
  }
  return @($items.ToArray())
}

<#
.SYNOPSIS
  The root of the app's process set: the Electron browser process ("the shell").
.DESCRIPTION
  A root is a member whose ParentProcessId is not the pid of another member. When several
  qualify, the one owning a main window wins (contract section 4.4).
#>
function Select-RootShell {
  param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Snapshot)

  $ids = @{}
  foreach ($item in $Snapshot) { $ids[[int]$item.Pid] = $true }

  $roots = @($Snapshot | Where-Object { -not $ids.ContainsKey([int]$_.ParentPid) })
  if ($roots.Count -eq 0) { $roots = @($Snapshot) }

  $withWindow = @($roots | Where-Object { [int64]$_.MainWindow -ne 0 })
  if ($withWindow.Count -gt 0) { return $withWindow[0] }
  return $roots[0]
}

<#
.SYNOPSIS
  Wait until no process of the app's set is left.
.OUTPUTS
  The survivors (empty when the set is gone).
#>
function Wait-ProcessSetGone {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][int] $TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ($true) {
    $remaining = @(Get-AppProcessSnapshot -Path $Path)
    if ($remaining.Count -eq 0) { return @() }
    if ((Get-Date) -ge $deadline) { return $remaining }
    Start-Sleep -Milliseconds 300
  }
}

# ── port (second half of the single-instance guard) ────────────────────────────────────────

<#
.SYNOPSIS
  Pids listening on the port, or an empty array when nothing listens.
.DESCRIPTION
  Get-NetTCPConnection is the contract's probe; a plain TCP connect is used when the NetTCPIP
  module is unavailable. -1 means "busy, owner unknown" (connect-probe path only).
#>
function Get-PortListenerPids {
  param([Parameter(Mandatory)][int] $PortNumber)

  if (-not $script:netTcpChecked) {
    $script:netTcpChecked = $true
    try {
      $command = Get-Command -Name 'Get-NetTCPConnection' -ErrorAction SilentlyContinue
      $script:netTcpAvailable = ($null -ne $command)
    } catch {
      $script:netTcpAvailable = $false
    }
  }

  if ($script:netTcpAvailable) {
    try {
      $connections = @(Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction Stop)
      $pids = New-Object System.Collections.ArrayList
      foreach ($connection in $connections) { [void]$pids.Add([int]$connection.OwningProcess) }
      return @($pids.ToArray())
    } catch {
      # "No matching MSFT_NetTCPConnection objects found" is the normal free-port case.
      return @()
    }
  }

  $probe = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $probe.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne(350, $false)) {
      try { $probe.EndConnect($async); return @(-1) } catch { return @() }
    }
    return @()
  } catch {
    return @()
  } finally {
    try { $probe.Close() } catch { }
  }
}

# ── starting the app ───────────────────────────────────────────────────────────────────────

<#
.SYNOPSIS
  Start the app through explorer.exe so Windows grants it foreground rights.
.DESCRIPTION
  A hidden background process may not take the foreground, so an app it starts directly can
  come up behind every other window. Explorer owns the desktop, so a process it starts is
  treated as a normal user launch.
.OUTPUTS
  A hashtable with Process (the transient explorer handle, or the app handle on fallback)
  and ViaExplorer.
#>
function Start-AppProcess {
  param([Parameter(Mandatory)][string] $Path)

  $explorer = Join-Path $env:SystemRoot 'explorer.exe'
  if (Test-Path -LiteralPath $explorer) {
    try {
      $handle = Start-Process -FilePath $explorer -ArgumentList @($Path) -PassThru -ErrorAction Stop
      return @{ Process = $handle; ViaExplorer = $true }
    } catch {
      Write-Note "explorer launch failed ($($_.Exception.Message)); starting the exe directly"
    }
  }
  $direct = Start-Process -FilePath $Path -PassThru -ErrorAction Stop
  return @{ Process = $direct; ViaExplorer = $false }
}

<#
.SYNOPSIS
  Report whether THIS process is inside a kill-on-close job object (best effort).
.DESCRIPTION
  The entire design rests on the worker NOT inheriting JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  (0x2000), so the worker records its own answer in `notes`. QueryInformationJobObject with a
  NULL job handle reports the job this process belongs to; when it belongs to none, the call
  fails and that failure is itself the "escaped" answer.
  Add-Type is guarded: a machine where it fails still restarts the app.
.OUTPUTS
  A short string for the notes list.
#>
function Get-JobState {
  try {
    Add-Type -Namespace DshRestart -Name SelfJob -ErrorAction Stop -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, out bool result);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, IntPtr info, int len, out int ret);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr GetCurrentProcess();
'@
  } catch {
    return "job state: self-report unavailable ($($_.Exception.Message))"
  }

  try {
    $inJob = $false
    [void][DshRestart.SelfJob]::IsProcessInJob([DshRestart.SelfJob]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)
    if (-not $inJob) { return 'job state: NOT in any job object (escaped)' }

    $size = 144
    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    try {
      for ($i = 0; $i -lt $size; $i++) { [System.Runtime.InteropServices.Marshal]::WriteByte($buffer, $i, 0) }
      $written = 0
      if ([DshRestart.SelfJob]::QueryInformationJobObject([IntPtr]::Zero, 9, $buffer, $size, [ref]$written)) {
        $flags = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 16)
        $killOnClose = (($flags -band 0x2000) -ne 0)
        return "job state: in job, killOnJobClose=$killOnClose, flags=$flags"
      }
      return 'job state: in a job, limit flags unreadable'
    } finally {
      [void][System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
  } catch {
    return "job state: self-report failed ($($_.Exception.Message))"
  }
}

<#
.SYNOPSIS
  Compile the two user32 helpers used to raise the new window (once, guarded).
#>function Initialize-ForegroundApi {
  if ($script:foregroundApiChecked) { return $script:foregroundApiReady }
  $script:foregroundApiChecked = $true
  $script:foregroundApiReady = $false
  try {
    Add-Type -Namespace DshRestart -Name Foreground -ErrorAction Stop -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool AllowSetForegroundWindow(int dwProcessId);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetForegroundWindow(IntPtr hWnd);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@
    $script:foregroundApiReady = $true
  } catch {
    $script:foregroundApiError = $_.Exception.Message
    $script:foregroundApiReady = $false
  }
  return $script:foregroundApiReady
}

<#
.SYNOPSIS
  Bring the relaunched app's window to the foreground (best effort).
.OUTPUTS
  $true when the window was raised.
#>
function Raise-AppWindow {
  param(
    [Parameter(Mandatory)][int] $ProcessId,
    [int] $Attempts = 20
  )

  if (-not (Initialize-ForegroundApi)) { return $false }
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    $window = [int64]0
    try { $window = [int64](Get-Process -Id $ProcessId -ErrorAction Stop).MainWindowHandle } catch { $window = [int64]0 }
    if ($window -ne 0) {
      [void][DshRestart.Foreground]::AllowSetForegroundWindow($ProcessId)
      [void][DshRestart.Foreground]::ShowWindow([IntPtr]$window, 9)   # SW_RESTORE
      if ([DshRestart.Foreground]::SetForegroundWindow([IntPtr]$window)) { return $true }
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

<#
.SYNOPSIS
  Wait for the relaunched instance to exist, and then for it to own a visible window.
.OUTPUTS
  A hashtable with New (a fresh process, or $null) and WindowFound (bool).
#>
function Wait-ForRestart {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][int] $TimeoutSeconds,
    [int[]] $ExcludePids = @()
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $newProcess = $null
  while ($true) {
    $current = @(Get-AppProcessSnapshot -Path $Path)
    $fresh = @($current | Where-Object { $ExcludePids -notcontains [int]$_.Pid })
    if ($fresh.Count -gt 0 -and $null -eq $newProcess) { $newProcess = $fresh[0] }
    $withWindow = @($fresh | Where-Object { [int64]$_.MainWindow -ne 0 })
    if ($withWindow.Count -gt 0) {
      return @{ New = $withWindow[0]; WindowFound = $true }
    }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Milliseconds 400
  }
  return @{ New = $newProcess; WindowFound = $false }
}

# ── quitting ───────────────────────────────────────────────────────────────────────────────

<#
.SYNOPSIS
  Terminate ONLY the root shell process.
.DESCRIPTION
  No graceful window close is attempted first: measured in the shell's own source, the main
  window `close` handler calls event.preventDefault() and hides to tray, so WM_CLOSE cannot
  end the app. The graceful half of this restart is the HOST's own IPC-disconnect shutdown,
  which runs by itself as soon as the shell is gone.
.OUTPUTS
  'terminated' | 'already-gone' | 'failed'.
#>
function Stop-RootProcess {
  param([Parameter(Mandatory)][int] $ProcessId)

  try {
    $live = Get-Process -Id $ProcessId -ErrorAction Stop
  } catch {
    return 'already-gone'
  }

  [void]$live
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    return 'terminated'
  } catch {
    [void]$script:notes.Add("Stop-Process failed for pid ${ProcessId}: $($_.Exception.Message)")
    return 'failed'
  }
}

# ── phase 1 / phase 2 entry ────────────────────────────────────────────────────────────────

$script:resolvedAppPath = Resolve-AppPath -Explicit $AppPath
if ($script:resolvedAppPath) {
  $script:resolvedExeName = [System.IO.Path]::GetFileNameWithoutExtension($script:resolvedAppPath)
}

$resolutionError = ''
if (-not $script:resolvedAppPath) {
  if ($AppPath) { $resolutionError = "the -AppPath given does not exist: $AppPath" }
  else { $resolutionError = 'no DeepSeek Harness executable was found (running process, DSH_DESKTOP_APP_PATH, or a known install location)' }
}

# The snapshot is taken in BOTH phases: it validates the target before any handoff and it
# fills shellPids/allPids in the result JSON.
$initial = @()
if ($script:resolvedAppPath) { $initial = @(Get-AppProcessSnapshot -Path $script:resolvedAppPath) }
$script:allPids = @($initial | ForEach-Object { [int]$_.Pid })

# ── PHASE 1: hand off to a process that is NOT in the app's job object ─────────────────────
if (-not $Worker) {

  if (-not $script:resolvedAppPath) {
    Complete-Run -Status 'app-not-found' -Code 4 -Detail ("Cannot restart: " + $resolutionError + '.')
  }

  # A dry run stays IN THIS PROCESS and hands nothing off. This guard is not optional:
  # without it a -DryRun invocation starts a real worker (observed while testing this very
  # script: the handoff ran and only the malformed command line kept the live app alive).
  if ($DryRun) {
    if ($initial.Count -eq 0) {
      Complete-Run -Status 'not-running' -Code 0 -Detail 'Dry run: the app is not running, so there is nothing to restart.'
    }
    $dryRoot = Select-RootShell -Snapshot $initial
    $script:shellPids = @([int]$dryRoot.Pid)
    Complete-Run -Status 'would-restart' -Code 0 -Detail ("Dry run: would terminate the root shell pid $($dryRoot.Pid) of $($initial.Count) process(es), wait up to ${QuitTimeoutSeconds}s, free port $Port, then relaunch. Nothing was changed and nothing was handed off.")
  }

  # Diagnostic only, on the caller side: proves the caller really was inside the app's job.
  [void]$script:notes.Add('caller ' + (Get-JobState))

  if ($initial.Count -gt 0) {
    $phase1Root = Select-RootShell -Snapshot $initial
    $script:shellPids = @([int]$phase1Root.Pid)
  }

  # A quoted token so a path with spaces (or CJK) survives the command line.
  $quote = {
    param([string] $Value)
    $doubled = $Value -replace '(\\+)$', '$1$1'
    return '"' + $doubled + '"'
  }
  # Switches MUST be emitted bare. Quoting them ('-Json') makes PowerShell pass a literal
  # string instead of a switch: under -File with [CmdletBinding()] the whole parameter
  # binding fails and the worker never runs at all, so the caller reports "launched" while
  # the terminal result never lands in -ResultPath. Measured by the Lead (a bare -Json binds,
  # a quoted '-Json' does not), and the same bug was observed here as a worker that silently
  # died. Do not "fix" it by removing [CmdletBinding()]: without it a quoted switch is
  # silently ignored instead of rejected, which is worse.
  $invariant = [System.Globalization.CultureInfo]::InvariantCulture

  # The interpreter running THIS script, and the FIRST token of the command line.
  # Win32_Process.Create resolves the first token as the executable path, so a command line
  # that starts with a switch fails with return value 9 ("path not found") — measured.
  $interpreterPath = ''
  try { $interpreterPath = [string](Get-Process -Id $PID).Path } catch { $interpreterPath = '' }
  if (-not $interpreterPath) { $interpreterPath = 'powershell.exe' }

  $workerArgs = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', (& $quote $PSCommandPath), '-Worker'
  )
  # The worker always reports as JSON: its stdout belongs to nobody, its result file matters.
  $workerArgs += '-Json'
  if ($QuitOnly) { $workerArgs += '-QuitOnly' }
  if ($AllowForce) { $workerArgs += '-AllowForce' }
  if ($SkipWorkerGuard) { $workerArgs += '-SkipWorkerGuard' }
  if ($ResultPath) { $workerArgs += @('-ResultPath', (& $quote $ResultPath)) }
  $workerArgs += @('-AppPath', (& $quote $script:resolvedAppPath))
  $workerArgs += @('-QuitTimeoutSeconds', $QuitTimeoutSeconds.ToString($invariant))
  $workerArgs += @('-StartTimeoutSeconds', $StartTimeoutSeconds.ToString($invariant))
  $workerArgs += @('-GraceSeconds', $GraceSeconds.ToString($invariant))
  $workerArgs += @('-Port', $Port.ToString($invariant))
  $workerCommandLine = (& $quote $interpreterPath) + ' ' + ($workerArgs -join ' ')

  $workerPid = 0
  $launchVia = 'wmi'
  $wmiError = ''

  try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $workerCommandLine } -ErrorAction Stop
    if ([int]$created.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($created.ReturnValue)" }
    $workerPid = [int]$created.ProcessId
  } catch {
    $wmiError = $_.Exception.Message
    $launchVia = 'explorer'
    # Fallback: a .cmd handed to explorer.exe also escapes the job (measured).
    try {
      $cmdPath = Join-Path $env:TEMP ('dsh-restart-handoff-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cmd')
      $cmdLines = @('@echo off', ('start "" ' + $workerCommandLine))
      Set-Content -LiteralPath $cmdPath -Value $cmdLines -Encoding ASCII
      Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList @($cmdPath) | Out-Null
      [void]$script:notes.Add("handoff .cmd: $cmdPath")
    } catch {
      Complete-Run -Status 'app-not-found' -Code 4 -Detail ("Could not hand off to the escaped worker. WMI: " + $wmiError + '. explorer: ' + $_.Exception.Message)
    }
  }

  if ($launchVia -eq 'wmi') {
    [void]$script:notes.Add("handoff via Win32_Process.Create, worker pid $workerPid")
  } else {
    [void]$script:notes.Add("WMI handoff failed ($wmiError); used the explorer fallback")
  }
  [void]$script:notes.Add("the worker is outside the app's job object by construction (see the header)")
  [void]$script:notes.Add("worker plan: sleep ${GraceSeconds}s, terminate shell $(($script:shellPids -join ', ')), wait up to ${QuitTimeoutSeconds}s, free port $Port, start, wait up to ${StartTimeoutSeconds}s")

  # Deliberately no wait for the worker: the caller is about to be terminated by it.
  Complete-Run -Status 'launched' -Code 0 -Detail ("Handoff complete ($launchVia). The escaped worker now owns the restart; the terminal result replaces this file.")
}

# ── PHASE 2: this process IS the escaped worker ────────────────────────────────────────────
try {

  # The decisive property, self-reported into the result file: this process must NOT be in a
  # kill-on-close job, otherwise it dies with the app instead of restarting it.
  [void]$script:notes.Add('worker ' + (Get-JobState))

  # ── single-worker guard ──────────────────────────────────────────────────────────────────
  # Two escaped workers racing would each terminate the shell and each start a new instance;
  # the single-instance lock would then silently discard one, and the two quit/start sequences
  # could interleave with a half-dead app. A machine-wide named mutex makes the second worker
  # report honestly instead of competing. DryRun never guards (it changes nothing).
  $script:workerMutex = $null
  if (-not $DryRun -and -not $SkipWorkerGuard) {
    $mutexName = 'Global\dsh-restart-worker'
    $acquired = $false
    try {
      $createdNew = $false
      $script:workerMutex = New-Object System.Threading.Mutex($false, $mutexName, [ref]$createdNew)
      try { $acquired = $script:workerMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    } catch {
      # A mutex we cannot create must not block a restart the user asked for; note and proceed.
      [void]$script:notes.Add('single-worker guard unavailable: ' + $_.Exception.Message)
      $script:workerMutex = $null
      $acquired = $true
    }
    if (-not $acquired) {
      Complete-Run -Status 'already-running' -Code 6 -Detail 'Another restart is already in progress; this request did nothing. Wait for it to finish, then try again.'
    }
  }

  if ($DryRun) {
    if (-not $script:resolvedAppPath) {
      Complete-Run -Status 'app-not-found' -Code 4 -Detail ("Dry run: " + $resolutionError + '.')
    }
    if ($initial.Count -eq 0) {
      Complete-Run -Status 'not-running' -Code 0 -Detail 'Dry run: the app is not running, so there is nothing to restart.'
    }
    $dryRoot = Select-RootShell -Snapshot $initial
    $script:shellPids = @([int]$dryRoot.Pid)
    Complete-Run -Status 'would-restart' -Code 0 -Detail ("Dry run: would terminate the root shell pid $($dryRoot.Pid) of $($initial.Count) process(es), wait up to ${QuitTimeoutSeconds}s, free port $Port, then relaunch. Nothing was changed.")
  }

  if (-not $script:resolvedAppPath) {
    Complete-Run -Status 'app-not-found' -Code 4 -Detail ("Cannot restart: " + $resolutionError + '.')
  }

  # A worker MUST get its target from the caller. Auto-detection here is a safety hole, not a
  # convenience: a worker whose -AppPath failed to bind silently re-detects the real app and
  # restarts it anyway. That is not hypothetical — while testing this script a worker whose
  # switches were mangled did exactly that and restarted the live app. Fail closed instead.
  if ($AppPath -eq '') {
    Complete-Run -Status 'app-not-found' -Code 4 -Detail 'Refusing to act: this worker was not given -AppPath, so it cannot know what the caller intended to restart. Nothing was terminated.'
  }

  if (-not (Test-Path -LiteralPath $script:resolvedAppPath -PathType Leaf)) {
    Complete-Run -Status 'app-not-found' -Code 4 -Detail ("Cannot restart: the resolved executable has disappeared: $($script:resolvedAppPath)")
  }

  # Grace delay: only useful when something is about to be terminated. It lets the caller's
  # command result render in the UI before the app goes away.
  if ($initial.Count -gt 0 -and $GraceSeconds -gt 0) {
    Write-Note "grace delay ${GraceSeconds}s before terminating"
    Start-Sleep -Seconds $GraceSeconds
  }

  # Re-read the set after the delay: this snapshot is what is actually acted on.
  $snapshot = @(Get-AppProcessSnapshot -Path $script:resolvedAppPath)
  $script:allPids = @($snapshot | ForEach-Object { [int]$_.Pid })
  Write-Note ("app: {0} ({1} process(es) before)" -f $script:resolvedAppPath, $snapshot.Count)

  if ($snapshot.Count -eq 0) {
    if ($QuitOnly) {
      Complete-Run -Status 'not-running' -Code 0 -Detail 'Nothing to quit: no matching process was running.'
    }
    $script:phase = 'start'
    $started = Start-AppProcess -Path $script:resolvedAppPath
    [void]$started
    [void]$script:notes.Add('the app was not running, so it was simply started')
    $result = Wait-ForRestart -Path $script:resolvedAppPath -TimeoutSeconds $StartTimeoutSeconds -ExcludePids @()
    if ($result.WindowFound) {
      $script:newShellPid = [int]$result.New.Pid
      $script:raised = $true
      if (-not (Raise-AppWindow -ProcessId $script:newShellPid)) {
        [void]$script:notes.Add('the window exists but could not be forced to the foreground')
      }
      Complete-Run -Status 'restarted' -Code 0 -Detail ("The app was not running and is up again (pid $($script:newShellPid)).")
    }
    if ($null -ne $result.New) {
      $script:newShellPid = [int]$result.New.Pid
      Complete-Run -Status 'start-failed' -Code 5 -Detail ("A new process appeared (pid $($script:newShellPid)) but it never owned a window within ${StartTimeoutSeconds}s.")
    }
    Complete-Run -Status 'start-failed' -Code 5 -Detail ("The app was started but no new process appeared within ${StartTimeoutSeconds}s.")
  }

  $rootShell = Select-RootShell -Snapshot $snapshot
  $script:shellPids = @([int]$rootShell.Pid)
  Write-Note "root shell: pid $($rootShell.Pid) (parent pid $($rootShell.ParentPid), $($snapshot.Count) member(s))"

  $script:phase = 'quit'
  $kill = Stop-RootProcess -ProcessId ([int]$rootShell.Pid)
  if ($kill -eq 'failed') {
    Complete-Run -Status 'quit-timeout' -Code 3 -Detail ("Could not terminate the root shell pid $($rootShell.Pid). See notes.")
  }
  Write-Note "root shell pid $($rootShell.Pid): $kill; the host now shuts itself down on IPC disconnect"

  $survivors = @(Wait-ProcessSetGone -Path $script:resolvedAppPath -TimeoutSeconds $QuitTimeoutSeconds)
  if ($survivors.Count -gt 0) {
    $survivorPids = @($survivors | ForEach-Object { [int]$_.Pid })
    if (-not $AllowForce) {
      # The safe default: nothing beyond the root shell is touched.
      Complete-Run -Status 'quit-timeout' -Code 3 -Detail ("$($survivors.Count) process(es) were still alive ${QuitTimeoutSeconds}s after the root shell (pid $($rootShell.Pid)) was terminated: $($survivorPids -join ', '). -AllowForce was not given, so nothing else was killed.")
    }
    [void]$script:notes.Add('force-killed')
    [void]$script:notes.Add("survivors after the quit timeout: $($survivorPids -join ', ')")
    foreach ($survivor in $survivors) {
      try { Stop-Process -Id ([int]$survivor.Pid) -Force -ErrorAction Stop } catch { [void]$script:notes.Add("could not kill pid $($survivor.Pid): $($_.Exception.Message)") }
    }
    $survivors = @(Wait-ProcessSetGone -Path $script:resolvedAppPath -TimeoutSeconds 20)
    if ($survivors.Count -gt 0) {
      $stillAlive = @($survivors | ForEach-Object { [int]$_.Pid })
      Complete-Run -Status 'quit-timeout' -Code 3 -Detail ("Even with -AllowForce, these processes survived: $($stillAlive -join ', ').")
    }
  }
  Write-Note 'the app process set has exited'

  if ($QuitOnly) {
    Complete-Run -Status 'quit-only' -Code 0 -Detail 'The app has been quit; no relaunch was requested.'
  }

  # Single-instance guard, second half: the port must be free before a new instance starts.
  $script:phase = 'start'
  $portDeadline = (Get-Date).AddSeconds([Math]::Max(5, $QuitTimeoutSeconds))
  # The `@(...)` around the call is REQUIRED, not stylistic. `Get-PortListenerPids`
  # ends in `return @()`, and PowerShell collapses an empty array returned from a
  # function to $null. Under this script's `Set-StrictMode` (any version >= 2.0), a
  # bare `$null.Count` throws `PropertyNotFoundException`, so
  #
  #     while ((Get-PortListenerPids -PortNumber $Port).Count -gt 0) { ... }
  #
  # threw on the NORMAL path — precisely when the port had just been freed and the
  # app was ready to be relaunched — and the phase handler reported `start-failed`
  # with the app left down. Measured on this machine with the real function against
  # a real free port:
  #
  #     (Get-PortListenerPids -PortNumber <free>).Count   -> PropertyNotFoundException
  #     @(Get-PortListenerPids -PortNumber <free>).Count  -> 0
  #
  # Line 872 already wraps its call; this one did not.
  while (@(Get-PortListenerPids -PortNumber $Port).Count -gt 0) {
    if ((Get-Date) -ge $portDeadline) {
      $holders = @(Get-PortListenerPids -PortNumber $Port)
      Complete-Run -Status 'start-failed' -Code 5 -Detail ("Port $Port is still listening (pid(s) $($holders -join ', ')) after the app exited; a new instance would fail to bind, so nothing was started.")
    }
    Start-Sleep -Milliseconds 300
  }
  Write-Note "port $Port is free"

  $launch = Start-AppProcess -Path $script:resolvedAppPath
  $exclude = @($script:allPids)
  if ($launch.ViaExplorer) { Write-Note 'launch requested through explorer.exe' } else { Write-Note 'launch requested directly' }

  $result = Wait-ForRestart -Path $script:resolvedAppPath -TimeoutSeconds $StartTimeoutSeconds -ExcludePids $exclude
  if ($result.WindowFound) {
    $script:newShellPid = [int]$result.New.Pid
    # `raised` means "the relaunched instance owns a visible main window"; the foreground
    # re-assert below is best effort and reported separately in `notes`.
    $script:raised = $true
    if (Raise-AppWindow -ProcessId $script:newShellPid) {
      [void]$script:notes.Add('window raised to the foreground')
    } else {
      if ($script:foregroundApiError) {
        [void]$script:notes.Add("window is up but could not be raised (user32 helper unavailable: $($script:foregroundApiError))")
      } else {
        [void]$script:notes.Add('window is up but could not be raised to the foreground')
      }
    }
    Complete-Run -Status 'restarted' -Code 0 -Detail ("The app is back: new shell pid $($script:newShellPid), port $Port.")
  }
  if ($null -ne $result.New) {
    $script:newShellPid = [int]$result.New.Pid
    Complete-Run -Status 'start-failed' -Code 5 -Detail ("The app started (pid $($script:newShellPid)) but no window appeared within ${StartTimeoutSeconds}s.")
  }
  Complete-Run -Status 'start-failed' -Code 5 -Detail ("No new app process appeared within ${StartTimeoutSeconds}s of the launch request.")

} catch {
  # Every unexpected error still produces a result file. The phase decides which documented
  # status is honest here, and the real exception text goes into `detail`.
  $status = 'app-not-found'
  $code = 4
  if ($script:phase -eq 'quit') { $status = 'quit-timeout'; $code = 3 }
  if ($script:phase -eq 'start') { $status = 'start-failed'; $code = 5 }
  [void]$script:notes.Add("exception type: $($_.Exception.GetType().FullName)")
  Complete-Run -Status $status -Code $code -Detail ("Unexpected error during the '$($script:phase)' phase: $($_.Exception.Message)")
}

# Safety net: the body above always exits through Complete-Run.
Complete-Run -Status 'app-not-found' -Code 4 -Detail 'The script reached the end of the worker path without a terminal state.'
