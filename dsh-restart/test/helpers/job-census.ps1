param(
  [Parameter(Mandatory=$true)][int[]]$Pid_,
  [string]$Out
)
# Answer "which job object(s) is pid N in, and is it kill-on-job-close?" for OTHER processes.
#
# The probe in _recon cannot answer this: QueryInformationJobObject(NULL, ...) inspects only
# the CALLER's own job, and NtQueryInformationProcess has no documented class that yields a
# job handle. So instead: enumerate every handle system-wide, duplicate the Job-type handles
# into this process, and test IsProcessInJob(target, thatJob) for each.
#
# The Job type index is discovered rather than assumed: create our own job object, find that
# exact handle value in the census, and read its type index. Self-validating by construction.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class JobCensus {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcessId();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, int da, bool i, int opt);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j, int cls, IntPtr info, int len, out int ret);
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr info, int len, out int ret);

  const int SystemExtendedHandleInformation = 64;
  const int EntrySize = 40;

  class H { public int Pid; public IntPtr Handle; public ushort TypeIndex; }

  static List<H> Enumerate() {
    int len = 1 << 22;
    IntPtr buf = Marshal.AllocHGlobal(len);
    int ret, st;
    while ((st = NtQuerySystemInformation(SystemExtendedHandleInformation, buf, len, out ret)) == unchecked((int)0xC0000004)) {
      Marshal.FreeHGlobal(buf); len *= 2; buf = Marshal.AllocHGlobal(len);
    }
    if (st != 0) { Marshal.FreeHGlobal(buf); throw new Exception("NtQuerySystemInformation status=0x" + st.ToString("X8")); }
    long count = Marshal.ReadInt64(buf, 0);
    var list = new List<H>((int)Math.Min(count, 500000));
    for (long i = 0; i < count; i++) {
      IntPtr p = (IntPtr)(buf.ToInt64() + 16 + i * EntrySize);
      list.Add(new H {
        Pid = (int)Marshal.ReadInt64(p, 8),
        Handle = (IntPtr)Marshal.ReadInt64(p, 16),
        TypeIndex = (ushort)Marshal.ReadInt16(p, 30),
      });
    }
    Marshal.FreeHGlobal(buf);
    return list;
  }

  static string JobFlags(IntPtr job) {
    int size = 144; IntPtr b = Marshal.AllocHGlobal(size);
    try {
      for (int i=0;i<size;i++) Marshal.WriteByte(b,i,0);
      int rr;
      if (!QueryInformationJobObject(job, 9, b, size, out rr)) return "\"flags\":null,\"queryError\":" + Marshal.GetLastWin32Error();
      uint f = (uint)Marshal.ReadInt32(b, 16);
      return "\"flags\":\"0x" + f.ToString("X") + "\",\"killOnJobClose\":" + (((f & 0x2000) != 0) ? "true" : "false");
    } finally { Marshal.FreeHGlobal(b); }
  }

  public static string Run(int[] targets) {
    var lines = new List<string>();
    IntPtr me = GetCurrentProcess();
    IntPtr own = CreateJobObject(IntPtr.Zero, null);
    if (own == IntPtr.Zero) throw new Exception("CreateJobObject failed " + Marshal.GetLastWin32Error());
    try {
      var all = Enumerate();
      lines.Add("handles_total=" + all.Count);
      int myPid = (int)GetCurrentProcessId();
      ushort jobType = 0; int found = 0;
      foreach (var h in all) if (h.Pid == myPid && h.Handle == own) { jobType = h.TypeIndex; found++; }
      if (found != 1) throw new Exception("could not identify Job type index (matches=" + found + ")");
      lines.Add("jobTypeIndex=" + jobType);

      var dupByObject = new Dictionary<long, IntPtr>();
      var procHandles = new Dictionary<int, IntPtr>();
      foreach (var h in all) {
        if (h.TypeIndex != jobType) continue;
        IntPtr ph;
        if (!procHandles.TryGetValue(h.Pid, out ph)) {
          ph = OpenProcess(0x0040, false, h.Pid);   // PROCESS_DUP_HANDLE
          procHandles[h.Pid] = ph;
        }
        if (ph == IntPtr.Zero) continue;
        IntPtr dup;
        if (!DuplicateHandle(ph, h.Handle, me, out dup, 0x0004, false, 0)) continue;  // DUPLICATE_SAME_ACCESS
        long key = h.Handle.ToInt64();
        if (!dupByObject.ContainsKey(key)) dupByObject[key] = dup; else CloseHandle(dup);
      }
      foreach (var kv in procHandles) if (kv.Value != IntPtr.Zero) CloseHandle(kv.Value);
      lines.Add("distinct_job_objects=" + dupByObject.Count);

      var jobs = new List<KeyValuePair<long, IntPtr>>(dupByObject);
      foreach (int t in targets) {
        IntPtr hp = OpenProcess(0x1000, false, t);   // PROCESS_QUERY_LIMITED_INFORMATION
        if (hp == IntPtr.Zero) { lines.Add("pid=" + t + " openProcessFailed=" + Marshal.GetLastWin32Error()); continue; }
        try {
          bool inAny;
          IsProcessInJob(hp, IntPtr.Zero, out inAny);
          var hits = new List<string>();
          foreach (var j in jobs) {
            bool r;
            if (IsProcessInJob(hp, j.Value, out r) && r) {
              hits.Add("{\"job\":\"0x" + j.Key.ToString("X") + "\"," + JobFlags(j.Value) + "}");
            }
          }
          lines.Add("pid=" + t + " inAnyJob=" + inAny + " jobs=" + hits.Count + (hits.Count == 0 ? "" : " " + string.Join(" ", hits)));
        } finally { CloseHandle(hp); }
      }
      foreach (var j in jobs) CloseHandle(j.Value);
    } finally { CloseHandle(own); }
    return string.Join("\r\n", lines);
  }
}
"@
$text = [JobCensus]::Run($Pid_)
if ($Out) { [System.IO.File]::WriteAllText($Out, $text, [System.Text.UTF8Encoding]::new($false)) } else { $text }
