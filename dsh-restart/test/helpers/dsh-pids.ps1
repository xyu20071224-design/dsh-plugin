param(
  [string]$Out
)
# Snapshot the DSH process set as JSON.
#
# Roles are classified from the command line. `isRootShell` is deliberately strict:
# the command line must be exactly the quoted exe path with no arguments at all, which
# is the Electron browser process. That is "the shell" the restart is allowed to quit.
# Other bare-looking processes exist (terminal hosts launched from the same exe) and are
# reported as ambiguous rather than silently folded into the shell set.
$ErrorActionPreference = 'Continue'
$exe = 'DeepSeek Harness.exe'
$rows = @(Get-CimInstance Win32_Process -Filter "Name='$exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $cl = [string]$_.CommandLine
  $role = if ($cl -match 'dsh-desktop-host') { 'HOST' }
          elseif ($cl -match '--type=renderer') { 'renderer' }
          elseif ($cl -match '--type=gpu') { 'gpu' }
          elseif ($cl -match '--type=utility') { 'utility' }
          elseif ($cl -match 'subprocess-local') { 'runner' }
          else { 'ambient' }
  $trimmed = $cl.Trim()
  $isRoot = $false
  if ($role -eq 'ambient') {
    $isRoot = ($trimmed -match '^"[^"]*"\s*$')
  }
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    role = $role
    isRootShell = $isRoot
    path = [string]$_.ExecutablePath
    commandLine = $cl
  }
})
$json = [pscustomobject]@{
  at = (Get-Date).ToString('o')
  count = $rows.Count
  pids = @($rows | ForEach-Object { $_.pid })
  rootShellPids = @($rows | Where-Object { $_.isRootShell } | ForEach-Object { $_.pid })
  hostPids = @($rows | Where-Object { $_.role -eq 'HOST' } | ForEach-Object { $_.pid })
  corePids = @($rows | Where-Object { $_.role -in @('renderer', 'gpu', 'utility') } | ForEach-Object { $_.pid })
  runnerPids = @($rows | Where-Object { $_.role -eq 'runner' } | ForEach-Object { $_.pid })
  ambientPids = @($rows | Where-Object { $_.role -eq 'ambient' } | ForEach-Object { $_.pid })
  rows = $rows
} | ConvertTo-Json -Depth 6 -Compress
if ($Out) { [System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false)) } else { $json }
