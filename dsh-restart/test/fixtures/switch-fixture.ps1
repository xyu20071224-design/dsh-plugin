[CmdletBinding()]
param(
  # Switches the restart script's handoff forwards to its escaped worker.
  [switch] $Worker,
  [switch] $Json,
  [switch] $QuitOnly,
  [switch] $AllowForce,

  [string] $ResultPath = '',
  [string] $AppPath = '',
  [string] $Marker = ''
)

# Regression fixture for the escaped-worker handoff.
#
# The handoff launches its worker through `Invoke-CimMethod Win32_Process Create` with a
# command line assembled by hand. That command line is the one thing in this package that
# cannot be checked by reading the source: a token that is not a syntactically valid switch
# either fails parameter binding outright (`[CmdletBinding()]` is present, so a quoted
# '-Json' aborts the process before param() runs) or binds to nothing at all. Either way the
# escaped worker dies or misbehaves, the terminal result file is never rewritten, and the
# user is told the restart is "unconfirmed" while nothing happens.
#
# This fixture mirrors the real script's parameter surface exactly, so the harness can replay
# the REAL observed handoff command line against it and see whether every switch arrived.
# It deliberately declares [CmdletBinding()], because that attribute is what turns a quoted
# switch from a silent no-op into a hard failure -- matching the shipped script.

$record = [pscustomobject][ordered]@{
  ranAt          = (Get-Date).ToString('o')
  pid            = $PID
  worker         = [bool]$Worker
  json           = [bool]$Json
  quitOnly       = [bool]$QuitOnly
  allowForce     = [bool]$AllowForce
  resultPath     = $ResultPath
  appPath        = $AppPath
  boundParameter = @($PSBoundParameters.Keys)
  commandLine    = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue).CommandLine
}

$target = if ($Marker) { $Marker } else { $ResultPath }
if ($target) {
  $folder = Split-Path -Parent $target
  if ($folder -and -not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
  [System.IO.File]::WriteAllText($target, ($record | ConvertTo-Json -Depth 4 -Compress), [System.Text.UTF8Encoding]::new($false))
}
