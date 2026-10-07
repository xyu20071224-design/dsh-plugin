param(
  [string]$Out,
  [int]$HoldMs = 0
)
# Self-report this process's Windows job-object state, as JSON.
#
# -HoldMs keeps THIS SAME process alive after writing the report, so an external
# observer (job-census.ps1) can inspect the identical live pid. Splitting the wait
# into a wrapper process would leave the reported pid already exited.
#
# QueryInformationJobObject(NULL, ...) inspects only the CALLER's own job, so this is
# trustworthy ONLY for the process that runs it. The harness uses it to (a) validate the
# cross-process oracle in job-census.ps1 against known ground truth, and (b) let a launched
# worker testify about itself -- which is exactly the B9 evidence.
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SelfJob {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j, int cls, IntPtr info, int len, out int ret);
  public static string Describe() {
    var sb = new StringBuilder();
    bool inJob;
    if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob)) return "\"inJob\":null,\"error\":\"IsProcessInJob failed " + Marshal.GetLastWin32Error() + "\"";
    sb.Append("\"inJob\":" + (inJob ? "true" : "false"));
    if (!inJob) return sb.ToString();
    int size = 144; IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      for (int i=0;i<size;i++) Marshal.WriteByte(buf,i,0);
      int ret;
      if (QueryInformationJobObject(IntPtr.Zero, 9, buf, size, out ret)) {
        uint flags = (uint)Marshal.ReadInt32(buf, 16);
        sb.Append(",\"flags\":\"0x" + flags.ToString("X") + "\",\"killOnJobClose\":" + (((flags & 0x2000) != 0) ? "true" : "false"));
      } else sb.Append(",\"flags\":null,\"queryError\":" + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(buf); }
    IntPtr b2 = Marshal.AllocHGlobal(65536);
    try {
      for (int i=0;i<65536;i++) Marshal.WriteByte(b2,i,0);
      int ret2;
      if (QueryInformationJobObject(IntPtr.Zero, 3, b2, 65536, out ret2)) {
        int assigned = Marshal.ReadInt32(b2, 0);
        var pids = new StringBuilder();
        for (int i=0;i<assigned && i<500;i++) {
          if (i > 0) pids.Append(",");
          pids.Append(Marshal.ReadInt32(b2, 8 + i*IntPtr.Size));
        }
        sb.Append(",\"processesInMyJob\":[" + pids.ToString() + "]");
      } else sb.Append(",\"processesInMyJob\":null");
    } finally { Marshal.FreeHGlobal(b2); }
    return sb.ToString();
  }
}
"@
$self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue
$session = -1
try { $session = (Get-Process -Id $PID).SessionId } catch { }
$base = [ordered]@{
  pid = $PID
  ppid = $(if ($self) { [int]$self.ParentProcessId } else { -1 })
  image = $(if ($self) { [string]$self.Name } else { '' })
  commandLine = $(if ($self) { [string]$self.CommandLine } else { '' })
  sessionId = $session
  userInteractive = [bool][Environment]::UserInteractive
} | ConvertTo-Json -Compress
$json = $base.Substring(0, $base.Length - 1) + ',' + [SelfJob]::Describe() + '}'
if ($Out) { [System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false)) } else { $json }
if ($HoldMs -gt 0) { Start-Sleep -Milliseconds $HoldMs }
