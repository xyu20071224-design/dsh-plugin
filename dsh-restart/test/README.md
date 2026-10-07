# Independent verification of `dsh-restart`

Owner: **verifier** (did not write `index.js` or `script\dsh-restart.ps1`).

Everything here is falsification-oriented: each check prints the exact command it ran and the
raw output it saw, so a reader can disagree with the verdict.

## Run it

```powershell
cd C:\agent\dsh\plugin\dsh-restart
node test\plugin-check.mjs                 # all sections, ~110 s
node test\plugin-check.mjs --only=A        # one section
node test\plugin-check.mjs --only=B8a,B9   # individual checks
```

Artifacts land in `test\artifacts\`: `summary.json` (machine-readable, one entry per check with
its evidence) and `check-log.txt` (the full transcript).

Exit code is 0 only when every check PASSes.

## What is checked

| id | check | how |
|---|---|---|
| A1 | syntax + manifest + `dsh.bundle.patch` | `node --check`, JSON parse, file existence |
| A2 | required exports | dynamic import of the module |
| A3 | `toCommandResult` never claims an unconfirmed restart | 8 contract statuses, 13 adversarial shapes, 27 fuzz shapes |
| A4 | registers into the **real** registry | `@deepseek-ai/dsh-commands` `CommandRuntime` extracted from the live `app.asar` — no stub. Non-vacuity control: the real registry rejects a duplicate. Also asserts unload disposes the command and that `Config` rejects a bad value |
| A5 | `/restart` rejects every argument | drives the **real handler** in a child process with all spawns intercepted |
| A7 | spawn argv matches CONTRACT §3 and the `-ResultPath` round trip works | fake launcher emits `launched`, harness writes a terminal status, asserts the handler reports it |
| A8 | resolvers under adversarial input | empty package dir, dead pid |
| B6 | parses on **both** PowerShell 5.1 and pwsh 7 | `[Parser]::ParseFile`, asserting zero parse errors |
| B7 | `-DryRun -Json` terminates nothing | DSH pid set captured before **and after**, compared |
| B8 gate | a missing `-AppPath` is inert | precondition that makes the non-DryRun checks safe |
| B8a | two-phase handoff really works | launcher < 3 s with `launched`, then a **terminal** status replaces the stub in `-ResultPath` |
| B8b | non-ASCII paths survive | CJK `-ResultPath` and `-AppPath`, asserting no BOM, no U+FFFD, CJK preserved |
| B9 | the escaped worker is not job-bound | observed **alive** from outside the tool-call job, with the oracle and a positive control |
| R1 | **regression**: the handoff must emit bare switches | replays the real handoff command line against a fixture with the production parameter surface |
| R2 | the WMI escape is causally why the worker survives | own `KILL_ON_JOB_CLOSE` job, natural child vs WMI child |
| C10 | no path claims success without a restart | source trace + status mapping |
| C11 | a wrong `-AppPath` cannot widen the terminate set | decoy process; asserts the terminate set is *only* the decoy and that DSH pids never appear |
| C12 | the host is never terminated | asserts no host pid is in the terminate set |
| C13 | the result file cannot leave the UI silent | bounded wait, missing/empty result mapping |
| E1 | the app is live after a real restart | observed process tree and port ownership |

## Safety model

The user's DSH is running and must not be killed. Three independent guards:

1. **`invokeScript()` is the only way this harness runs the script.** A non-`-DryRun` invocation
   is refused unless its `-AppPath` lives under `test/artifacts/decoy/` — i.e. the harness's own
   purpose-built decoy, never the real app. The check is re-evaluated immediately before the call.
2. **Every invocation snapshots the DSH pid set on both sides.** A removed core pid
   (`SHELL`/`HOST`/`renderer`/`gpu`/`utility`) is recorded as a mutation and fails the check.
   Transient `runner`/`ambient` pids are labelled by role and reported as harness noise.
3. **The plugin's spawn path is only ever exercised in child processes** started with
   `--import test/scenarios/preload.mjs`, which redirects every spawn to an armed fake and
   **throws** on an unarmed one. The parent never patches `spawn`.

### Why guard 3 exists (an incident, recorded honestly)

An earlier revision of this harness had a static `import { spawn } from 'node:child_process'`
and patched `require('node:child_process').spawn` afterwards. The static import had already
bound the real function, so the patch was inert, and the harness's own argument-validation case
silently executed a **real, non-`-DryRun` restart against the live app** at 14:51:34.

The product behaved correctly; the test technique was the defect. The repair is
`syncBuiltinESMExports()` in `preload.mjs`, applied before `index.js` is evaluated — plus the
fail-closed guard so an unarmed spawn can never reach the real implementation. Evidence and
impact are recorded in `test\artifacts\observed-restart.json`.

## Helpers

| file | purpose |
|---|---|
| `helpers/dsh-pids.ps1` | snapshot the DSH process set, classified by role |
| `helpers/self-job.ps1` | a process self-reporting its own job membership (trustworthy only for itself) |
| `helpers/job-census.ps1` | **cross-process** job oracle: enumerate all handles, duplicate Job-type ones, `IsProcessInJob` per target. Self-validating type index |
| `helpers/watch-worker.ps1` | start the handoff and watch the escaped worker from outside the tool-call job |
| `helpers/inspect-worker.ps1` | catch a worker while alive and census it |
| `helpers/joblab.ps1` | self-contained causal experiment: own kill-on-close job, natural vs WMI child |
| `helpers/make-decoy.ps1` + `decoy-source.cs` | build the windowless decoy executable |
| `helpers/switch-handoff-probe.ps1` | replay the handoff command line in four spellings |
| `fixtures/switch-fixture.ps1` | fixture mirroring the production parameter surface for R1 |
| `scenarios/preload.mjs` | fail-closed spawn interception, applied before the plugin loads |
| `scenarios/handler-spawn.mjs` | drives the real handler with every spawn faked |

## Known limitations (stated, not assumed away)

* **`-DryRun` is the only mode that touches the real app.** The quit/relaunch path itself is
  exercised against the decoy, not against DSH. A real end-to-end restart of DSH did happen once
  during this session (see `observed-restart.json`) and it completed successfully, but it is not
  reproducible on demand inside the harness by design.
* **Window raising is not verified.** `raised` is asserted only in the sense that a window must
  exist for `restarted`; actually forcing the foreground cannot be verified without a visible
  window, and the decoy deliberately has none.
* **`quit-timeout`, `already-running` and the `-AllowForce` branch are not exercised.** Each
  requires a deliberately wedged or duplicated worker; those are script-dev's stated
  "unverified" list and remain unverified here.
* **The host's graceful-shutdown path** is asserted from source reading (IPC disconnect →
  `shutdown.shutdown(0)`, bounded at 5 s), not measured by this harness.
* **B9's timing is inherently racy.** The worker lives ~12 s against the decoy, which is ample,
  but a much faster worker could outrun the census; when that happens B9 reports the race as a
  failure rather than passing vacuously.
