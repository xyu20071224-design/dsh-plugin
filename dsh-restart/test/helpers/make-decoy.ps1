param(
  [Parameter(Mandatory=$true)][string]$Dir,
  [string]$Out
)
# Build the verification decoy executable with the .NET Framework compiler that ships with
# Windows (csc.exe under Framework64). No SDK, no network, no installs.
#
# The decoy is a real, long-lived, windowless process at a unique image path. The harness
# retargets the restart script's -AppPath at a copy of it, so the script's terminate set and
# its launch target are entirely outside the user's DSH. Existence is checked by the script
# (Test-Path -PathType Leaf), and "live process" is what makes the terminate set non-empty.
#
# It deliberately never owns a main window: that keeps the script waiting in
# Wait-ForRestart for the full -StartTimeoutSeconds, which is what lets the harness inspect
# the escaped worker while it is still alive (check B9).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$source = Join-Path $PSScriptRoot 'decoy-source.cs'
if (-not (Test-Path -LiteralPath $source)) { throw "decoy source missing: $source" }
if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }

$exe = Join-Path $Dir 'verifier-decoy.exe'
$csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found: $csc" }

if (Test-Path -LiteralPath $exe) { Remove-Item -LiteralPath $exe -Force }
$compile = & $csc /nologo /target:exe ("/out:" + $exe) $source 2>&1
$ok = Test-Path -LiteralPath $exe
$result = [pscustomobject]@{
  ok      = $ok
  exe     = $exe
  csc     = $csc
  output  = ($compile | Out-String).Trim()
  bytes   = if ($ok) { (Get-Item -LiteralPath $exe).Length } else { 0 }
}
$json = $result | ConvertTo-Json -Compress
if ($Out) { [System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false)) } else { $json }
if (-not $ok) { exit 1 }
