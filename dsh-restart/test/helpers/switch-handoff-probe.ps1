param(
  [Parameter(Mandatory=$true)][string]$Fixture,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Interpreter = 'C:\Program Files\PowerShell\7\pwsh.exe'
)
# REGRESSION for the escaped-worker handoff's switch quoting.
#
# Replays the REAL handoff shape -- `Invoke-CimMethod Win32_Process Create` with a
# hand-assembled command line -- against `test/fixtures/switch-fixture.ps1`, which declares
# the same `[CmdletBinding()] param([switch]...)` surface as the production script.
#
# Four spellings are tried, because only the observed one can prove the fix:
#   bare           -Json                  <- the correct repair
#   quoted-single  '-Json'                <- the shipped defect (aborts under [CmdletBinding])
#   quoted-double  "-Json"                <- binds, but is fragile
#   first-token    '-Json' first          <- the OTHER bug: Win32_Process.Create resolves the
#                                            first token as an image path and returns 9
# Each case reports whether the process ran at all and, if it did, whether every switch bound.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$workDir = Split-Path -Parent $Out
if (-not (Test-Path -LiteralPath $workDir)) { New-Item -ItemType Directory -Force -Path $workDir | Out-Null }

function Invoke-Case {
  param([string]$Name, [string]$CommandLine, [string]$Marker)

  Remove-Item -LiteralPath $Marker -Force -ErrorAction SilentlyContinue
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $CommandLine }
  $returnValue = [int]$created.ReturnValue
  $pid_ = [int]$created.ProcessId

  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $Marker) { break }
    Start-Sleep -Milliseconds 150
  }

  $record = $null
  if (Test-Path -LiteralPath $Marker) {
    try { $record = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json } catch { $record = $null }
  }

  $ran = ($null -ne $record)
  $allBound = $false
  if ($ran) {
    $allBound = ($record.worker -eq $true) -and ($record.json -eq $true) -and
                ($record.quitOnly -eq $true) -and ($record.allowForce -eq $true)
  }

  [pscustomobject]@{
    case            = $Name
    commandLine     = $CommandLine
    wmiReturnValue  = $returnValue
    wmiPid          = $pid_
    fixtureRan      = $ran
    allSwitchesTrue = $allBound
    observed        = if ($ran) { [pscustomobject]@{ worker = $record.worker; json = $record.json; quitOnly = $record.quitOnly; allowForce = $record.allowForce; bound = @($record.boundParameter) } } else { $null }
  }
}

$cases = @()

# --- the CORRECT shape: bare switches, interpreter path quoted first --------
$cases += Invoke-Case -Name 'bare' -Marker (Join-Path $workDir 'probe-bare.json') -CommandLine (
  '"' + $Interpreter + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Fixture + '" -Worker -Json -QuitOnly -AllowForce -Marker "' + (Join-Path $workDir 'probe-bare.json') + '"'
)

# --- the SHIPPED defect: single-quoted switches -----------------------------
$cases += Invoke-Case -Name 'quoted-single' -Marker (Join-Path $workDir 'probe-sq.json') -CommandLine (
  '"' + $Interpreter + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Fixture + '" -Worker ' + "''-Json''" + ' ' + "''-QuitOnly''" + ' ' + "''-AllowForce''" + ' -Marker "' + (Join-Path $workDir 'probe-sq.json') + '"'
)

# --- double-quoted switches (binds, kept as a documented alternative) -------
$cases += Invoke-Case -Name 'quoted-double' -Marker (Join-Path $workDir 'probe-dq.json') -CommandLine (
  '"' + $Interpreter + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Fixture + '" -Worker "-Json" "-QuitOnly" "-AllowForce" -Marker "' + (Join-Path $workDir 'probe-dq.json') + '"'
)

# --- the OTHER bug: a switch as the command line's FIRST token --------------
$cases += Invoke-Case -Name 'switch-first-token' -Marker (Join-Path $workDir 'probe-first.json') -CommandLine (
  "''-Json'' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ + $Fixture + """ -Worker -Marker """ + (Join-Path $workDir 'probe-first.json') + '"'
)

$payload = [pscustomobject]@{
  at        = (Get-Date).ToString('o')
  fixture   = $Fixture
  cases     = $cases
  verdict   = [pscustomobject]@{
    # A PASS requires the bug shape to fail AND the fix shape to work: a fixture that never
    # runs at all, or a control that cannot fail, proves nothing either way.
    bareBindsEverything        = [bool]($cases | Where-Object { $_.case -eq 'bare' } | ForEach-Object { $_.allSwitchesTrue })
    shippedShapeFailsToRun     = -not [bool]($cases | Where-Object { $_.case -eq 'quoted-single' } | ForEach-Object { $_.fixtureRan })
    switchFirstTokenFails      = ([int]($cases | Where-Object { $_.case -eq 'switch-first-token' } | ForEach-Object { $_.wmiReturnValue }) -ne 0)
  }
} | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($Out, $payload, [System.Text.UTF8Encoding]::new($false))
