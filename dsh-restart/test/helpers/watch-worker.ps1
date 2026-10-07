param(
  [Parameter(Mandatory=$true)][string]$ScriptPath,
  [Parameter(Mandatory=$true)][string]$AppPath,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [string]$Out,
  [int]$WatchSeconds = 20,
  [int]$Port = 45999
)
# Capture what actually happens to the escaped worker, from OUTSIDE the tool-call job.
#
# This process is launched by the harness; it starts the script's phase 1, then watches for
# a process that is genuinely the worker: image pwsh/powershell, command line containing the
# script path AND '-Worker'. Filtering on the image name is essential -- a bare command-line
# match also catches the watcher's own parent, which produced a false positive earlier.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$log = New-Object System.Collections.ArrayList
function Note([string]$m) {
  $line = ('[{0}] {1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $m)
  [void]$log.Add($line)
}

function Get-Workers {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and
    $_.CommandLine -and
    $_.CommandLine.Contains($ScriptPath) -and
    $_.CommandLine -match "(^|\s)'-?Worker'?(\s|$)|(^|\s)-Worker(\s|$)"
  } | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate)
}

Note "watcher pid=$PID"
Note "script=$ScriptPath"
Note "app=$AppPath"

$launcherArgs = @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', $ScriptPath, '-Json', '-ResultPath', $ResultPath,
  '-AppPath', $AppPath, '-Port', "$Port",
  '-StartTimeoutSeconds', '8', '-QuitTimeoutSeconds', '10', '-GraceSeconds', '0.5'
)
$sw = [Diagnostics.Stopwatch]::StartNew()
$stdout = & 'C:\Program Files\PowerShell\7\pwsh.exe' @launcherArgs 2>&1 | Out-String
Note ("launcher exit=$LASTEXITCODE elapsed=$($sw.ElapsedMilliseconds)ms")
Note ("launcher stdout: " + $stdout.Trim())

$seen = @{}
$deadline = (Get-Date).AddSeconds($WatchSeconds)
while ((Get-Date) -lt $deadline) {
  foreach ($w in Get-Workers) {
    $k = [int]$w.ProcessId
    if (-not $seen.ContainsKey($k)) {
      $seen[$k] = $true
      Note ("WORKER SEEN pid=$k ppid=$($w.ParentProcessId) name=$($w.Name) at +$($sw.ElapsedMilliseconds)ms")
      Note ("  cmdline: " + $w.CommandLine)
      # Is the worker in a job? Ask the oracle while it is alive.
      $censusOut = Join-Path $env:TEMP ('worker-census-' + $k + '.txt')
      if (Test-Path 'C:\agent\dsh\plugin\dsh-restart\test\helpers\job-census.ps1') {
        & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File `
          'C:\agent\dsh\plugin\dsh-restart\test\helpers\job-census.ps1' -Pid_ $k -Out $censusOut 2>&1 | Out-Null
        if (Test-Path $censusOut) { Note ("  census: " + ((Get-Content $censusOut -Raw) -replace "`r?`n", ' | ')) }
      }
    }
  }
  $alive = @(Get-Workers).Count
  Note ("t=+$($sw.ElapsedMilliseconds)ms aliveWorkers=$alive resultFile=$(Test-Path $ResultPath)") 
  Start-Sleep -Milliseconds 400
}

$final = ''
if (Test-Path $ResultPath) { $final = Get-Content $ResultPath -Raw }
$payload = [pscustomobject]@{
  launcher = [pscustomobject]@{ exit = $LASTEXITCODE; stdout = $stdout.Trim() }
  workerPids = @($seen.Keys)
  finalResult = $final
  log = @($log)
} | ConvertTo-Json -Depth 6
if ($Out) { [System.IO.File]::WriteAllText($Out, $payload, [System.Text.UTF8Encoding]::new($false)) } else { $payload }
