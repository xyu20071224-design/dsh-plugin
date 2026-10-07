param(
  [Parameter(Mandatory=$true)][string]$AppPath,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Port = 45999
)
# Reproduce the script's OWN handoff and capture the worker's stdio.
#
# The script launches its worker through Win32_Process.Create, which gives the worker no
# inherited stdio at all. That makes a worker crash invisible. This helper builds the SAME
# escaped launch but wraps it in a .cmd that redirects BOTH streams to a log file, so the
# worker's own error output survives the escape.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script = 'C:\agent\dsh\plugin\dsh-restart\script\dsh-restart.ps1'
$interp = 'C:\Program Files\PowerShell\7\pwsh.exe'
$logPath = [System.IO.Path]::ChangeExtension($Out, '.worker-stdio.txt')
Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ResultPath -Force -ErrorAction SilentlyContinue

# The EXACT command line the script generates, per its own quoting helpers.
$workerCommand = '"' + $interp + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass' +
  ' -File "' + $script + '"' +
  " -Worker '-Json'" +
  ' -ResultPath "' + $ResultPath + '"' +
  ' -AppPath "' + $AppPath + '"' +
  ' -QuitTimeoutSeconds 10 -StartTimeoutSeconds 8 -GraceSeconds 0.5 -Port ' + $Port

$cmdPath = Join-Path $env:TEMP ('dsh-restart-stdio-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cmd')
$cmdLines = @(
  '@echo off',
  ('call ' + $workerCommand + ' > "' + $logPath + '" 2>&1'),
  'echo EXITCODE=%ERRORLEVEL% >> "' + $logPath + '"'
)
Set-Content -LiteralPath $cmdPath -Value $cmdLines -Encoding ASCII

$launchCommand = '"' + (Join-Path $env:SystemRoot 'System32\cmd.exe') + '" /c "' + $cmdPath + '"'
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $launchCommand }

# Wait for the worker to finish (or time out).
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $logPath) {
    $content = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
    if ($content -and $content -match 'EXITCODE=') { break }
  }
  Start-Sleep -Milliseconds 300
}
Start-Sleep -Milliseconds 500

$payload = [pscustomobject]@{
  wmiReturnValue = [int]$created.ReturnValue
  wmiPid         = [int]$created.ProcessId
  workerCommand  = $workerCommand
  cmdPath        = $cmdPath
  logPath        = $logPath
  logExists      = (Test-Path -LiteralPath $logPath)
  workerStdio    = if (Test-Path -LiteralPath $logPath) { (Get-Content -LiteralPath $logPath -Raw) } else { '' }
  resultExists   = (Test-Path -LiteralPath $ResultPath)
  resultContent  = if (Test-Path -LiteralPath $ResultPath) { (Get-Content -LiteralPath $ResultPath -Raw) } else { '' }
  appStillAlive  = [bool](Get-Process -Id (Get-Process -Name 'verifier-decoy' -ErrorAction SilentlyContinue | Select-Object -First 1).Id -ErrorAction SilentlyContinue)
}
$json = $payload | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath $cmdPath -Force -ErrorAction SilentlyContinue
