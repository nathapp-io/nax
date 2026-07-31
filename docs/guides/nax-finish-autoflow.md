# Autonomous Finish Flow (`nax-finish`)

`nax-finish` takes a feature branch that a `nax run` just implemented and drives
it to a **review-ready PR** — or to a clearly-flagged escalation — without a
human in the terminal.

It runs as an [acpx flow](https://www.npmjs.com/package/acpx) triggered by a
built-in nax post-run plugin. It auto-fixes what it can, and on anything needing
human judgment it **stops and escalates** rather than guessing. It never merges.

> The interactive, approval-gated `nax-finish` skill still exists for manual
> finishes. This is the autonomous path, not a replacement.

---

## 1. What it does

```
load_ctx          detect base branch, resolve the feature spec + acceptance groups,
                  check the branch is ahead of base (else: nothing-to-finish)
  ↓
acceptance        run the feature's acceptance tests
  ↳ fail → fix_acceptance (agent) → commit → re-run [max 3 attempts → escalate]
  ↓
review_spec       spec-relative review, isolated session, own agent profile
  ↳ clean            → skip to review_quality
  ↳ recommended fix  → fix_spec (agent) → commit → re-run acceptance → re-review
  ↳ needs judgment   → escalate
  ↓
review_quality    code-quality review, isolated session, own agent profile
  ↳ clean            → skip to quality_gates
  ↳ recommended fix  → fix_quality (agent) → commit → re-review
  ↳ needs judgment   → escalate
  ↓
quality_gates     run the repo's own quality.commands at the repo root
  ↳ red → fix_gate (agent) → commit → re-run        [max 3 attempts → escalate]
  ↳ none configured → escalate (a gate that verified nothing is not a pass)
  ↓
open_pr           commit + push the fixes, then open a ready PR
                  (or promote the draft autoPR already opened)
```

Every fix node is followed by a `commit_*` node that commits the agent's edits
locally (no push). The reviewers read `git diff <base>...HEAD`, so a fix left
uncommitted is invisible to the re-review — the loop would re-report findings it
had already fixed and escalate at the cap ([#1397](https://github.com/nathapp-io/nax/issues/1397)).
The fix agent itself is still told not to commit; the flow owns the history.

Both terminal nodes (`open_pr`, `escalate`) commit and push first, so the PR — or
the escalation — describes state a human can actually see.

| Outcome | Result |
|:---|:---|
| All green | **Ready** PR/MR opened, or an existing draft promoted. Never merged. |
| Fixable findings | Applied, re-verified, up to 3 attempts per phase. |
| Spec conflict, contradiction, design call, or can't reach green | Partial fixes pushed, escalation sent, **no ready PR**. |
| Branch not ahead of base | `nothing-to-finish`, stops. |

The terminal state is written to `.nax/nax-finish-result.json`:

```json
{ "feature": "auth-hardening", "status": "promoted", "url": "https://github.com/o/r/pull/42" }
```

`status` is one of `opened`, `promoted`, `already-ready`, `escalated`,
`nothing-to-finish`. Add it to `.gitignore`.

---

## 2. Prerequisites

| Requirement | Check |
|:---|:---|
| `acpx` with flows support on `PATH` | `acpx flow run --help` |
| At least one ACP agent working | `acpx claude 'say hi'` |
| `gh` or `glab` authenticated | `gh auth status` / `glab auth status` |
| `quality.commands` configured in `.nax/config.json` | see below — **required** |
| Acceptance tests for the feature | `nax features resolve <feature> --json` |

**`quality.commands` is not optional.** The flow's final gate runs those commands
at the repo root. With none configured it escalates instead of opening a PR:

```json
{
  "quality": {
    "commands": {
      "build": "bun run build",
      "typecheck": "bun run typecheck",
      "lint": "bun run lint",
      "test": "bun run test"
    }
  }
}
```

Commands run through `/bin/sh -c`, so `&&`, quoting and globs work as written.
Only the repo-root `.nax/config.json` is read for this gate — per-package
overrides don't verify the repo root.

---

## 3. Enable it

```json
{
  "finish": {
    "autoFlow": {
      "enabled": true
    }
  }
}
```

That's the minimum. It then fires after a `nax run` when **all** of these hold:

- the run succeeded — at least one completed story, no failed and no paused ones
- `HEAD` is not `main` / `master`
- `enabled` is `true`

It is off by default, and a failure inside the flow never fails your run (the
post-run driver treats it as non-blocking and logs a warning).

### Full config

```json
{
  "finish": {
    "autoFlow": {
      "enabled": true,
      "flowPath": "flows/nax-finish/nax-finish.flow.ts",
      "defaultAgent": "claude",
      "reviewers": {
        "spec": "nax-spec-reviewer",
        "quality": "nax-quality-reviewer"
      },
      "escalate": { "telegram": true },
      "timeouts": {
        "acceptanceMs": 600000,
        "gateMs": 900000,
        "flowMs": 5400000,
        "stepMs": null
      }
    }
  }
}
```

| Key | Default | Meaning |
|:---|:---|:---|
| `enabled` | `false` | Master gate. |
| `flowPath` | `flows/nax-finish/nax-finish.flow.ts` | Resolved against the **nax install** first, then your repo (vendor a variant by putting a file at the same relative path), then used as-is if absolute. |
| `defaultAgent` | `null` | acpx agent for any node without a pinned profile. Unset → acpx's own `defaultAgent`. |
| `reviewers.spec` | `null` | acpx agent profile for the spec-review phase — see §4. |
| `reviewers.quality` | `null` | acpx agent profile for the quality-review phase. |
| `escalate.telegram` | `true` | Prefer Telegram for escalations when credentials resolve; else PR/MR comment. |
| `timeouts.acceptanceMs` | 600000 (10 min) | Cap per acceptance-test group. |
| `timeouts.gateMs` | 900000 (15 min) | Cap per quality gate. |
| `timeouts.flowMs` | 5400000 (90 min) | Cap on the whole `acpx flow run`. |
| `timeouts.stepMs` | `null` | Cap per flow step (one agent turn), passed to acpx as `--timeout`. `null` keeps acpx's own 15-minute default — raise it if reviews of large diffs get cut off. |

---

## 4. Configuring the reviewer agent profiles (acpx)

The two review phases run as **separate isolated acpx sessions**, so each can use
a different agent and model — e.g. a powerful adversarial model for the spec lens
and a cheaper one for code quality.

`reviewers.spec` and `reviewers.quality` are **acpx agent names**. A name is
either a built-in (`claude`, `codex`, `pi`, `gemini`, `opencode`, …) or a key you
define in the `agents` map of your acpx config. The model is encoded in that
entry's command/args — acpx has no separate model field.

### Where acpx config lives

acpx reads, later winning:

1. global — `~/.acpx/config.json`
2. project — `<cwd>/.acpxrc.json`

Inspect the resolved result with `acpx config show`; create the global template
with `acpx config init`.

### Defining named reviewer profiles

`~/.acpx/config.json`:

```json
{
  "defaultAgent": "claude",
  "agents": {
    "nax-spec-reviewer": {
      "command": "claude-agent-acp",
      "args": ["--model", "opus"]
    },
    "nax-quality-reviewer": {
      "command": "claude-agent-acp",
      "args": ["--model", "sonnet"]
    }
  }
}
```

Then in `.nax/config.json`:

```json
{
  "finish": {
    "autoFlow": {
      "enabled": true,
      "reviewers": { "spec": "nax-spec-reviewer", "quality": "nax-quality-reviewer" }
    }
  }
}
```

Each entry needs a non-empty `command`; `args` is an optional array of strings
that acpx appends (quoted) to it. Names are normalised, so `nax-spec-reviewer`
and `Nax_Spec_Reviewer` refer to the same profile.

### Mixing agents across phases

Nothing requires both phases to use the same underlying agent:

```json
{
  "agents": {
    "spec-lens": { "command": "codex-acp", "args": ["--model", "gpt-5.2"] },
    "quality-lens": { "command": "claude-agent-acp", "args": ["--model", "sonnet"] }
  }
}
```

```json
{ "reviewers": { "spec": "spec-lens", "quality": "quality-lens" } }
```

### Overriding a built-in's command

You can also redefine a built-in name — useful for a local checkout or extra env:

```json
{
  "agents": {
    "claude": { "command": "env ANTHROPIC_LOG=debug claude-agent-acp" }
  }
}
```

### Resolution order per node

1. the node's pinned profile — `reviewers.spec` / `reviewers.quality`
2. else `finish.autoFlow.defaultAgent` (passed to acpx as `--default-agent`)
3. else acpx config `defaultAgent`
4. else acpx's built-in fallback

Fix nodes (`fix_acceptance`, `fix_spec`, `fix_quality`, `fix_gate`) are never
pinned — they always use the default agent.

Verify a profile resolves before enabling the flow:

```bash
acpx nax-spec-reviewer 'reply with OK'
```

### How the profiles reach the flow

The plugin passes them as the env vars `NAX_FINISH_SPEC_PROFILE` and
`NAX_FINISH_QUALITY_PROFILE`, which the flow module reads at load time. You can
set them yourself when running the flow by hand (§6).

---

## 5. Escalation

On anything needing human judgment the flow pushes what it fixed and sends a
"needs judgment" summary naming the reason and the findings.

**Telegram (preferred when configured).** Credentials come from the telegram
interaction plugin, or from env:

```json
{
  "interaction": {
    "plugin": "telegram",
    "config": { "botToken": "…", "chatId": "…" }
  }
}
```

```bash
export NAX_TELEGRAM_TOKEN=…      # or TELEGRAM_BOT_TOKEN
export NAX_TELEGRAM_CHAT_ID=…
```

When Telegram is enabled **and** credentialed, the flow posts no PR comment and
opens no draft to hold one.

**PR/MR comment (fallback).** With `escalate.telegram: false`, or no credentials,
the flow comments on the branch's existing PR/MR — opening a *draft* to hold the
comment only if none exists. It never opens a ready PR while escalating.

---

## 6. Running the flow by hand

Useful for debugging without a full `nax run`. It performs real work — it edits
files, pushes, and can open a PR.

First locate the flow that ships with your nax install:

```bash
NAX_ROOT="$(dirname "$(dirname "$(readlink -f "$(command -v nax)")")")"
FLOW="$NAX_ROOT/flows/nax-finish/nax-finish.flow.ts"
ls "$FLOW"    # if this is missing, your nax predates the shipped flows/ directory
```

Then:

```bash
acpx --approve-all flow run "$FLOW" \
  --input-json '{
    "feature": "auth-hardening",
    "workdir": "'"$PWD"'",
    "branch": "'"$(git branch --show-current)"'",
    "prdPath": ".nax/features/auth-hardening/prd.json",
    "escalateTelegram": false,
    "timeouts": { "acceptanceMs": 600000, "gateMs": 900000 }
  }' \
  --default-agent claude
```

Flag placement matters: `--approve-all` (and `--timeout`) are top-level flags and
must precede `flow`; `--default-agent` belongs to `flow run` and must follow the
flow file. The flow declares `requireExplicitGrant`, so `--approve-all` must be
an explicit CLI flag — `defaultPermissions` in acpx config does not satisfy it.

Run state is kept under `~/.acpx/flows/runs/`.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|:---|:---|
| `nax-finish: flow module "…" not found` | `flows/` missing from the nax install. Reinstall nax, or point `flowPath` at an absolute path. |
| `unknown option '--default-agent'` | The flag was placed before `flow run`. Fixed in nax; if calling acpx by hand, move it after the flow file. |
| `Flow "nax-finish" requires an explicit approve-all grant` | Pass `--approve-all` on the command line. |
| Escalates with `No quality.commands configured` | Configure `quality.commands` (§2). The flow won't call an unverified branch green. |
| Escalates with `still failing after 3 fix attempts` | The agent couldn't fix it — the cap is deliberate. Take it from here manually. |
| Nothing happens after a run | Check `enabled`, that no story failed or paused, and that `HEAD` isn't `main`/`master`. |
| A review step is cut off mid-way | Raise `timeouts.stepMs` (acpx's default step cap is 15 minutes). |
| Flow killed at 90 minutes | Raise `timeouts.flowMs`. |
| PR opened without the flow's fixes | Should not happen — both terminal nodes push first. Check for a failed push in the run output or the escalation comment. |
| Duplicate PRs vs nax autoPR | Not possible by design: the flow promotes an existing draft rather than opening a second PR. |

---

## See also

- [configuration.md](./configuration.md) — the `finish.autoFlow` key reference
- [triggers.md](./triggers.md) — other post-run hooks
- `flows/nax-finish/` — the flow module itself
