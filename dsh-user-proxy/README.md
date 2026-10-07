# dsh-user-proxy

An **agent preset** for DeepSeek Harness: one identity that can read every session on the
host, across every workspace, and diagnose one that stopped.

It is the third layer of [`dsh-session-watch`](../dsh-session-watch/). That plugin detects a
session which stopped silently and can resume it under policy; this preset is how you find
out **why** it stopped, which a policy cannot work out on its own.

## What it gives you

Pick **「User Proxy」** when creating a session, and that agent gets three extra tools:

| Tool | What it does | Access |
|---|---|---|
| `session_roster` | Every session on the host, its verdict, and whether policy will act on it | read |
| `session_review` | One session's conversation plus the deterministic facts about how it stopped — open turn, retry count, which tools failed | read |
| `session_resume` | Resume one stalled session | **write** |

## Why it needs its own preset

A tool's visibility comes from the **Cordis context that registered it**, and this preset
contains the row (`session-watch/proxy`) that registers these three. So they exist only for
sessions composed from this preset.

That is the security boundary, and it is measured rather than assumed: a `standard` session
sees 52 tools and this preset sees 55, and the difference is exactly these three. A session
running `standard` **cannot** read other sessions' conversations, and there is no runtime
check anyone could forget to perform.

The privilege is real — `session_roster` and `session_review` read conversation text from
every workspace — which is precisely why it lives in a preset you have to choose.

## Installing

It is a **bundle**, so installing it also registers the preset:

```powershell
dsh plugin --profile <your-profile> add .\dsh-user-proxy
```

It depends on `dsh-session-watch` for the `session-watch/proxy` row it composes. Install
both, then **restart the app** — a plugin's module is cached by name, so the preset is only
composed from the new code after a restart.

## The part that will bite you: the plugin list is copied

A preset's `plugins` is a **complete list**, not a patch over another preset. The Loader
replaces `config` wholesale and never deep-merges, so there is no "standard plus one row".

This file therefore contains the shipped `standard` preset **verbatim**, with the proxy row
appended. If `standard` changes upstream, this file does **not** follow, and the failure is
silent: the preset would quietly lose a tool.

`dsh-session-watch/test/preset-drift.mjs` exists for exactly that. It reads the deployed
`standard.patch.yml` **out of the installed asar** and diffs it row by row against this file,
failing loudly on any divergence.

## Details

The reasoning behind each choice — why the list is copied, what the privilege covers, and
how the tools behave — is written up in [`cordis.patch.yml`](cordis.patch.yml) itself, which
is the file that actually declares the preset.
