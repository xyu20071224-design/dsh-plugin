param(
  [Parameter(Mandatory=$true)][string]$OutPath,
  [int]$LifeSeconds = 6,
  [int]$StartDelayMs = 800
)
# Positive control for kill-on-job-close, built entirely from the tool-call environment.
#
# A process is placed in a KILL_ON_JOB_CLOSE job (via an AssignProcessToJobObject on a child
# this process spawns), then the job handle is closed. A naturally spawned grandchild dies
# with the close; a WMI-created grandchild survives it. This mirrors the surrogate experiment
# in _recon/surrogate/orchestrate.ps1, but it runs inside ONE tool call and emits JSON.
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class JobLab {
  [StructLayout(LayoutKind.Sequential)]
  public struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)]
  public struct EXT { public BASIC BasicLimitInformation; public IO IoInfo; public UIntPtr a; public UIntPtr b; public UIntPtr c; public UIntPtr d; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr h, int c, IntPtr i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  public static IntPtr Make() {
    IntPtr j = CreateJobObject(IntPtr.Zero, null);
    if (j == IntPtr.Zero) throw new Exception("CreateJobObject failed");
    var e = new EXT(); e.BasicLimitInformation.LimitFlags = 0x2000;
    int len = Marshal.SizeOf(typeof(EXT)); IntPtr p = Marshal.AllocHGlobal(len);
    try {
      Marshal.StructureToPtr(e, p, false);
      if (!SetInformationJobObject(j, 9, p, (uint)len)) throw new Exception("SetInformationJobObject failed " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(p); }
    return j;
  }
  public static bool Assign(IntPtr job, int pid) {
    var pr = System.Diagnostics.Process.GetProcessById(pid);
    return AssignProcessToJobObject(job, pr.Handle);
  }
  public static bool InJob(int pid) {
    try { var pr = System.Diagnostics.Process.GetProcessById(pid); bool r; IsProcessInJob(pr.Handle, IntPtr.Zero, out r); return r; }
    catch { return false; }
  }
  public static bool Alive(int pid) { try { var p = System.Diagnostics.Process.GetProcessById(pid); return !p.HasExited; } catch { return false; } }
}
"@

$body = @'
param([string]$Marker, [int]$Seconds)
# Heartbeat: append a line every 400ms so a survivor is distinguishable from a corpse.
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  Add-Content -LiteralPath $Marker -Value ((Get-Date).ToString('HH:mm:ss.fff')) -Encoding ascii
  Start-Sleep -Milliseconds 400
}
'@
$bodyPath = Join-Path $env:TEMP ('verifier-beat-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
Set-Content -LiteralPath $bodyPath -Value $body -Encoding UTF8

$job = [JobLab]::Make()
$plainMarker = Join-Path $env:TEMP ('verifier-plain-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.txt')
$wmiMarker = Join-Path $env:TEMP ('verifier-wmi-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.txt')

# 1. A natural child, launched by THIS process, then assigned into the job.
$plain = Start-Process -FilePath 'C:\Program Files\PowerShell\7\pwsh.exe' `
  -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $bodyPath, '-Marker', $plainMarker, '-Seconds', "$LifeSeconds") `
  -WindowStyle Hidden -PassThru
# 2. A WMI-created child (escapes the job by construction).
$wmiCmd = '"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -NonInteractive -File "' + $bodyPath + '" -Marker "' + $wmiMarker + '" -Seconds ' + $LifeSeconds
$wmi = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $wmiCmd }

Start-Sleep -Milliseconds $StartDelayMs
# Assign ONLY the natural child into the kill-on-close job. The WMI child is deliberately
# left alone: the whole claim under test is that a WMI-created process is NOT a job member,
# so assigning it would destroy the very property being measured (an earlier run did exactly
# that and produced a false "no escape" result).
$assignedPlain = $false
try { $assignedPlain = [JobLab]::Assign($job, $plain.Id) } catch { $assignedPlain = $false }
$assignedWmi = $false   # never assigned; kept in the payload to show it was not touched

Start-Sleep -Milliseconds 1500
$inJobBeforePlain = [JobLab]::InJob($plain.Id)
$inJobBeforeWmi = [JobLab]::InJob([int]$wmi.ProcessId)

# Close the job handle -> KILL_ON_JOB_CLOSE fires for every member.
[void][JobLab]::CloseHandle($job)
Start-Sleep -Milliseconds 1200
$plainAfterClose = [JobLab]::Alive($plain.Id)
$wmiAfterClose = [JobLab]::Alive([int]$wmi.ProcessId)

Start-Sleep -Seconds ($LifeSeconds + 1)
$plainBeats = if (Test-Path $plainMarker) { @(Get-Content $plainMarker).Count } else { 0 }
$wmiBeats = if (Test-Path $wmiMarker) { @(Get-Content $wmiMarker).Count } else { 0 }

$payload = [pscustomobject]@{
  plain = [pscustomobject]@{ pid = $plain.Id; assignedToJob = $assignedPlain; inJob = $inJobBeforePlain; aliveAfterJobClose = $plainAfterClose; beats = $plainBeats; marker = $plainMarker }
  wmi   = [pscustomobject]@{ pid = [int]$wmi.ProcessId; assignedToJob = $assignedWmi; inJob = $inJobBeforeWmi; aliveAfterJobClose = $wmiAfterClose; beats = $wmiBeats; marker = $wmiMarker }
  verdict = [pscustomobject]@{
    jobKilledThePlainProcess = (-not $plainAfterClose)
    wmiProcessSurvived = $wmiAfterClose
    causalLinkEstablished = ((-not $plainAfterClose) -and $wmiAfterClose)
  }
}
$json = $payload | ConvertTo-Json -Depth 5 -Compress
Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
foreach ($m in @($plainMarker, $wmiMarker)) { Remove-Item -LiteralPath $m -Force -ErrorAction SilentlyContinue }
if ($OutPath) { [System.IO.File]::WriteAllText($OutPath, $json, [System.Text.UTF8Encoding]::new($false)) } else { $json }
