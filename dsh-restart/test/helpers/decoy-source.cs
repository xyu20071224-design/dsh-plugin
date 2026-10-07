using System;
using System.Threading;

// Verification decoy: a process that exists at a unique image path, stays alive, and
// deliberately owns NO main window. The dsh-restart verification harness retargets the
// script's -AppPath at a copy of this program so the script's terminate set and launch
// target are entirely outside the user's DSH. Because it never owns a window, the script's
// Wait-ForRestart keeps the escaped worker alive for the full -StartTimeoutSeconds window,
// which is what lets the harness observe the worker while it is still running.
public static class VerificationDecoy
{
    public static int Main(string[] args)
    {
        int seconds = 120;
        if (args.Length > 0)
        {
            int parsed;
            if (int.TryParse(args[0], out parsed) && parsed > 0) seconds = parsed;
        }
        Thread.Sleep(seconds * 1000);
        return 0;
    }
}
