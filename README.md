# DSH Plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) — a desktop agent
harness. Each directory is an independent plugin package, loaded by the DSH desktop app.

| Plugin | What it does |
|---|---|
| [`dsh-session-watch`](dsh-session-watch/) | Watches **every** session on the host, catches the ones that stopped silently mid-turn, and can resume them under a policy you control. Ships an agent preset for root-cause diagnosis. |
| [`dsh-user-proxy`](dsh-user-proxy/) | The **agent preset** that carries `dsh-session-watch`'s expert tools. Installed as a bundle; gives one agent cross-workspace read access to all sessions. |
| [`dsh-restart`](dsh-restart/) | Restarts the app from inside itself, cleanly. Exists because DSH caches plugin **modules** by name — a config change hot-reloads, code does not. |

`dsh-user-proxy` and `dsh-session-watch` are a pair: the preset is what makes the watcher's
third layer usable. Install both or neither.

---

## Install

Plugin packages are installed as **bundles** into a DSH profile, which also registers any
agent presets they declare:

```powershell
# From the cloned repo, for each plugin you want:
dsh plugin --profile <your-profile> add .\dsh-user-proxy
dsh plugin --profile <your-profile> add .\dsh-session-watch
```

Then add a row to `%USERPROFILE%\.dsh\cordis.patch.yml` so the Host half loads:

```yaml
- insert:
    - id: session-watch
      name: 'dsh-session-watch'
      config:
        # Silence before a RUNNING session counts as stalled. See the plugin README:
        # 900000 is measured, not chosen.
        stallMs: 900000
        minAgeMs: 60000
        resume:
          enabled: false        # start here; turn on once you have watched it behave
          maxAttempts: 2
          baseDelayMs: 120000
          maxDelayMs: 1800000
          cooldownMs: 300000
```

**Restart the app after installing.** A plugin's module is cached by name, so new code is
not picked up until the process restarts — `config` hot-reloads, code does not. See
[`dsh-restart`](dsh-restart/) for doing that from inside the app.

---

## The safety model, in one paragraph

The watcher can send a message into your sessions, so the interesting question is what it
refuses to do. **Only a session classified `stalled` is ever auto-resumed.** A session parked
on an approval prompt, a question to you, a user abort, an empty session or a subagent is
reported and left alone — resuming an approval wait would mean answering a question on your
behalf. Every attempt is capped, backed off, and written to a shared ledger that names its
author (`auto` / `manual` / `user-proxy`), because an automatic action you cannot see is
indistinguishable from the harness acting on its own.

Full detail, including the measured numbers behind each threshold and the defects found
along the way, is in [`dsh-session-watch/STATUS.md`](dsh-session-watch/STATUS.md).

---

## Development

Every package is plain ESM with **no build step and no runtime dependencies**. Tests run on
Node's built-in test-free harness (`node test/run-all.mjs`) and are designed to work without
the GUI running.

```powershell
cd dsh-session-watch
node test/run-all.mjs        # everything
node test/replay.mjs         # classify real on-disk logs, read-only
```

Tests that need a live Host read `http://127.0.0.1:19387` by default and accept a base URL
argument, so they can be pointed at a scratch instance instead.

### A note on test fixtures

Several suites learned this the hard way, and the lesson is recorded in the sources: a
fixture drawn from what the code *expects* only proves the code is self-consistent. Twice a
fixture used an event name that no real log emits, so the suite happily verified that a
fictional event was handled correctly while a real session was misclassified. Fixtures here
are written from observed data — real log shapes, real event names, real timestamps.

---

## Licence

[MIT](LICENSE).
