# S5-4 Task 8 — Live checks: results

Run of `docs/superpowers/plans/2026-10-09-s5-4-auth-release.md` Task 8, on `main` at
`eeb09ebbe` (the lockstep release commit), `2026-10-09`. All four published packages are
`0.84.0`. The billed acpx smoke ran with maintainer approval.

## Summary

| Step | What | Result |
|---|---|---|
| 2 | Build, pack and install the tarballs | Pass |
| 3 | acpx smoke: session, edit, reconnect, list | Pass (one lock nuance, not a defect) |
| 4 | `auth_required` smoke (free) | Pass |
| 4b | `nax-agent login` exits on its own | Pass (non-interactive + Ctrl+C paths) |
| 5 | Zed walkthrough | Pass (6/6; one finding, #2414) |
| 6 | Record commit / model / cost / Zed checks | Done (cost from the provider dashboard only) |

Environment: `node v22.22.2`, `bun 1.4.2`, `acpx@0.19.4` via `npx`.

## Step 2 — packed tarballs

```
SMOKE=/tmp/nax-agent-smoke-C50F
packages/nax-agent     -> nathapp-nax-agent-0.84.0.tgz
packages/nax-agent-acp -> nathapp-nax-agent-acp-0.84.0.tgz
npm install ./nathapp-nax-agent-*.tgz ./nathapp-nax-agent-acp-*.tgz
```

- `"$SMOKE/node_modules/.bin/nax-agent" --version` → `0.84.0`
- `npm ls @nathapp/nax-ai` → `@nathapp/nax-agent@0.84.0` → `@nathapp/nax-ai@0.84.0`

The tarball's `@nathapp/nax-ai` pin resolved from the now-published registry at the same
`0.84.0`. **Pass.**

## Step 3 — acpx smoke (billed: 2 model turns)

```
WORK=/tmp/nax-agent-work-qsas
NAX_AGENT_SESSIONS_DIR="$SMOKE/sessions"
ACPX=(npx -y acpx@0.19.4 --cwd "$WORK")
AGENT=(--agent "$BIN acp")
```

- `sessions new` → created a session.
- `--approve-all --ttl 1` prompt "Create hello.txt containing exactly: hi" →
  `[tool] Write hello.txt (completed)` with a diff, `end_turn`. `cat hello.txt` → `hi`.
- After `sleep 5` (past `--ttl 1`): `no agent process` — the queue owner and agent exited.
- Second prompt (no `--ttl`) started a **fresh** agent process, did `session/resume`, and
  answered `hi` — reconnect/load works.
- `sessions` lists one session.
- `$NAX_AGENT_SESSIONS_DIR` holds one `*.session.json` and one `*.transcript.json`.

Session `e12256ae-1343-4133-8c70-057ed243eefb`, model `minimax/MiniMax-M3`, mode `ask`,
title "Create hello.txt containing exactly: hi".

**Lock nuance (not a defect).** At the moment of the check a `.lock` was present, held by a
still-alive agent process. acpx keeps the agent as its `__queue-owner` after the last prompt
(only the first call used `--ttl 1`), so the lock is legitimately held while the agent runs.
Sending `SIGTERM` to that process removed the `.lock`, leaving only the session and
transcript files — the lock is released on exit. The plan's "no `.lock` left behind" assumes
the agent has already exited; with acpx's default keep-alive it is held until then. Storage
also treats a lock whose pid is dead as stale and takes it over. **Pass.**

## Step 4 — auth_required (free, no model call)

```
env -u ANTHROPIC_API_KEY NAX_AGENT_CONFIG_DIR="$EMPTY" \
  npx -y acpx@0.19.4 --cwd "$WORK2" --agent "$BIN acp --model anthropic/claude-sonnet-5-5" sessions new
```

Output:

```
Authentication required: no credentials for provider "anthropic". Log in with `nax-agent login anthropic` (or `nax auth login anthropic`), then retry.
exit=1
```

The error names `nax-agent login anthropic`; no tokens spent. **Pass.**

## Step 4b — `nax-agent login` exits on its own

Run under `tmux` (real TTY). `--config-dir` pointed at a scratch dir, never `~/.nax`.

- `login anthropic --method api-key` → prompted `? Enter Anthropic API key` → (dummy key) →
  `Signed in to anthropic (method: api-key, credential: api-key)` → **returned to the shell
  prompt**; no hang.
- `login openrouter` → menu → `Sign in with OpenRouter` → started a localhost callback
  listener (`http://127.0.0.1:55448/oauth/callback/…`), printed the OpenRouter auth URL, and
  waited for the browser/code. **Ctrl+C → `exit=130`**, returned to the prompt; no hang.

`pgrep -fl nax-agent` printed nothing after both. The final-review I5 concern (OAuth handles
keeping Node alive) does **not** reproduce; `bin/nax-agent.js` needs no change. Scratch dirs
removed. **Pass** for the exit behaviour.

## Step 5 — Zed walkthrough (maintainer, 2026-10-09)

Zed 1.23.2 on macOS, `@nathapp/nax-agent-acp@0.84.0` installed globally with bun, project
`/tmp/nax-agent-work-qsas`, models `minimax/MiniMax-M3` and `minimax/MiniMax-M2.7`.

| # | Check | Result |
|---|---|---|
| 1 | Text and thinking stream into the thread | Pass |
| 2 | `ask` mode: edit shows a diff and a permission prompt; Allow writes the file | Pass |
| 3 | Stop mid-turn; the thread keeps working | Pass |
| 4 | Switch model in the picker; earlier turns are remembered | Pass |
| 5 | Quit Zed, reopen, open the thread from history; it replays | Pass |
| 6 | Empty config: login prompt, `nax-agent login`, retry answers | Pass, with a finding |

Setup notes, now in the package README:
- Zed's live settings file is `~/.config/zed/settings.json`.
- Zed started from the Dock does not see the shell `PATH`. With nvm-managed node, `"command":
  "nax-agent"` cannot start; `command` must be the absolute `node` path and `args` the absolute
  `bin/nax-agent.js` path plus `acp`.

Check 6 ran with a second agent entry whose `env` set `NAX_AGENT_CONFIG_DIR` to an empty
directory, so `~/.nax` was never moved. Zed's GUI environment held no provider API keys.

**Finding (#2414).** With a truly empty config the thread fails with `invalid params: no model
configured: set models.native.balanced or --model`. `session/new` resolves the model before the
credential pre-flight, so a first-time user with no `~/.nax` never sees the login prompt. With
`NAX_AGENT_MODEL=minimax/MiniMax-M3` added, Zed showed the login prompt; logging in stored a
`0600` `credentials` file in that directory, and the retried thread answered ("hi" ->
"Hi! How can I help you today?"). The test entry and directory were removed afterwards.

## Step 6 — Record

- Commit: `eeb09ebbe` (tag `v0.84.0`)
- Models: `minimax/MiniMax-M3` (acpx smoke, Zed), `minimax/MiniMax-M2.7` (Zed)
- Billed turns: ~2 in the acpx smoke; a handful of short Zed turns.
- Cost: **not stored** in `*.transcript.json` (no usage/cost fields) — read it from the
  provider dashboard.
- Zed checks: 6/6 pass (Step 5).

## Remaining

1. Step 4b interactive completion — the OAuth flow was only exercised up to Ctrl+C; a real
   browser sign-in was not completed (API-key path fully exercised).
2. #2414 — a first-time user with no model configured gets no login prompt.

Scratch dirs `/tmp/nax-agent-smoke-C50F` and `/tmp/nax-agent-work-qsas` can be deleted.
