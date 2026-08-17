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
  ↳ acceptance disabled in config → skip cleanly
  ↳ no PRD, or a package's test never generated → escalate
                  (nothing verified is not a pass — same rule as quality_gates)
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
quality_gates     re-run the feature's acceptance tests (gate zero), then the
                  repo's own quality.commands at the repo root
  ↳ red → fix_gate (agent) → commit → re-review     [max 3 attempts → escalate]
          (a gate fix that touched production code re-enters review_quality;
           a test-only fix, or one that changed nothing, returns to the gates)
  ↳ none configured → escalate (a gate that verified nothing is not a pass)
  ↓
open_pr           commit + push the fixes, then open a ready PR
                  (or promote the draft autoPR already opened)
```

Every fix node is followed by a `commit_*` node that commits the agent's edits
locally (no push, `--no-verify`). The reviewers read `git diff <base>...HEAD`, so
a fix left uncommitted is invisible to the re-review — the loop would re-report
findings it had already fixed and escalate at the cap ([#1397](https://github.com/nathapp-io/nax/issues/1397)).

Each `commit_*` node writes a commit whose subject names what was fixed and
whose body lists the findings behind it, so a human reviewing the PR can triage
the flow's commits without reading every diff. It also appends the round to the
[audit trail](#audit-trail).

**Gate fixes to production code are reviewed.** The gate loop is the last loop
to edit the tree, and it used to route straight back to `quality_gates` — which
proves the repo's commands are green, something a bad fix can satisfy. A gate fix
that touches non-test files now re-enters `review_quality` first. Both loops keep
their own 3-attempt caps, so the re-entry cannot run away.

> **Known gap — test-only gate fixes are not re-reviewed.** The re-review is the
> flow's most expensive node and a gate fix is usually a mechanical test repair,
> so a commit whose every path matches the repo's test-file patterns skips it.
> This is a deliberate cost tradeoff with a real edge: the defect that motivated
> the re-entry in the first place was itself test-only — eight copy-pasted stubs
> across three test files. If test-quality regressions start reaching your PRs,
> widen `gateCommitRoute` in `nax-finish.flow.ts`.
>
> Classification comes from `nax features resolve --json` (`testPatterns`), which
> reports the repo's own patterns via the ADR-009 resolver — so it is correct for
> Go, Python and Rust packages, not just `*.test.ts`. When the patterns cannot be
> resolved at all, the fix is treated as non-test and **is** reviewed.

The fix agent itself is still told not to commit; the flow owns the history.

These are internal checkpoints, so they skip your pre-commit hooks: a hook that
runs lint or typecheck would otherwise reject an intermediate state the gate
loop was about to fix, and take the whole flow down with it. Nothing is lost —
`quality_gates` runs the repo's own build/typecheck/lint/test and no PR opens
unless they pass. The terminal commit before pushing runs hooks normally.

Both terminal nodes (`open_pr`, `escalate`) commit and push first, so the PR — or
the escalation — describes state a human can actually see.

### Why re-reviews are narrower than the first pass

A reviewer's first pass reads the spec in full and the whole
`git diff <base>...HEAD`. Re-running that verbatim on every round made reviews
**58% of the flow's wall clock** on one measured run (7 review calls, 1306s of
2232s), most of it re-reading code an earlier round had already cleared.

So a re-review is scoped: it is given the findings it raised last round and
`git diff <shaAtLastReview>..HEAD` — the fix, and nothing else — and asked two
questions. Are these findings actually resolved (a weakened assertion, a deleted
test or a disabled check is **not** resolved)? And did the fix break anything,
including in the unchanged code it now calls into?

Scope here means *what is judged*, not *what may be read*: the reviewer still has
the spec and the whole repo, and is told so explicitly.

The narrowing only applies when it is provably safe — when exactly one commit
separates the two reviews, so that commit's parent **is** the tree the previous
verdict passed on. Anything else (the first review of a phase, or two commits in
the window, which happens when the acceptance loop commits between a spec fix and
its re-review) falls back to a full review rather than guessing at a window and
silently hiding code from the reviewer.

### What a reviewer node returns

Each reviewer replies in three sections, and all three are checked:

| Section | Content | If missing |
|:--------|:--------|:-----------|
| `## TOUCHPOINTS` | one line per external definition the reviewer opened, or `- none — <justification>` | the review is sent back once, then escalated — never treated as clean |
| `## WALK` | one line per AC (spec phase) or per changed function (quality phase) | same |
| `## FINDINGS` | `[SEVERITY]` blocks, or the literal `No findings.` | a reply with neither blocks nor the sentinel routes `reprompt` |

The touchpoint paths are checked against the repo, so a fabricated list is
rejected as an incomplete review. There is no JSON: a reply constrained to one
JSON object has nowhere to put the two enumerations the review dimensions depend
on, and an unreadable object used to discard the whole review (#1614).

### What a fix node can reject

`fix_<phase>` does not have to apply every finding it is handed. When it has
cited counter-evidence that the reported behaviour is already correct — an
existing test or spec line that pins the current behaviour — it can reject the
finding instead, in a fourth reply section:

```
## DISPOSITIONS
[1] fixed
[2] rejected — evidence: test/config/loader.test.ts:42
```

Each line is `[N] fixed` or `[N] rejected — evidence: <file:line>`, where `N`
is the finding's 1-based index in the same list the reviewer sent. A rejection
requires the citation — it must point at a real test or spec line, not a
description of what the fixer believes. `commit_<phase>` checks that the cited
path resolves in the repo; a citation that does not is not discarded, only
marked — the fixer may have cited a line rather than a path, or the file may
have moved — and both the PR body and the commit message render it with an
**evidence path not found** caveat rather than presenting it as verified.

A rejected finding shows up in the PR body's "Review rounds" section as
`_rejected_: \`file:line\`` (or with the caveat above when the path didn't
resolve), and the shipped `commit_<phase>` commit message renders it the same
way — as rejected with its citation, never as `Fix: <text>` for a change that
was never made.

This is a different, separately-scoped convention from a reviewer's
`Judgment: yes` marker (see [§5 Escalation](#5-escalation)): `Judgment` is
reviewer-authored and escalates a finding to a human before any fix is
attempted; `## DISPOSITIONS … rejected` is fixer-authored and rejects a
finding on cited evidence instead of applying it. Don't conflate the two —
they run at different points in the loop and mean different things.

### Why acceptance runs twice

The `acceptance` node is the cheap fail-fast gate: it proves the feature meets
its own contract before a full LLM review is spent on it. But two fix loops run
*after* it — quality review and the gate loop — and both edit code. The repo-root
`test` command does not cover the feature's acceptance tests: they are generated
per-feature under `<packageDir>/.nax/features/<feature>/` and usually need their
own runner config (a separate jest/vitest/pytest invocation), which is exactly
why they are excluded from the normal suite. So a quality-phase fix could break
the contract the first gate proved, and nothing downstream would notice.

Re-running them as gate zero of `quality_gates` makes one property true on every
path: **nothing reaches `open_pr` without the feature's own acceptance tests
passing against the tree as it will ship.** A failure there routes to `fix_gate`
with the failing output, so it is repaired rather than escalated.

It runs unconditionally, even on the all-green path where nothing changed since
the first run. Skipping it when no fix has landed is derivable from the step
history, but a conditional correctness check that can be *wrong* is worse than a
cheap one that cannot — a missed re-run is a silent false green, the failure
mode this exists to prevent. Acceptance is the cheapest gate in the pipeline;
the redundant run costs seconds against a flow that spends minutes in review.

| Outcome | Result |
|:---|:---|
| All green | **Ready** PR/MR opened, or an existing draft promoted. Never merged. |
| Fixable findings | Applied, re-verified, up to 3 attempts per phase. |
| Spec conflict, contradiction, design call, or can't reach green | Partial fixes pushed, escalation sent, **no ready PR**. |
| Branch not ahead of base | `nothing-to-finish`, stops. |

### Audit trail

The flow writes two files per run, under nax's per-project output directory
alongside `prompt-audit/` and `review-audit/` — not in your repo:

```
~/.nax/<project>/finish-audit/<feature>/<runId>.jsonl        one line per fix round
~/.nax/<project>/finish-audit/<feature>/<runId>.result.json  terminal state
```

A `config.outputDir` override is honoured. Files are named by run id, so
finishing the same feature twice keeps both trails.

The result file:

```json
{ "feature": "auth-hardening", "status": "promoted", "url": "https://github.com/o/r/pull/42" }
```

`status` is one of `opened`, `promoted`, `already-ready`, `escalated`,
`nothing-to-finish`.

Every terminal status — not just `escalated` — carries a `rounds` array
replaying what the flow fixed to get there. A finish that needed four rounds is
the case most worth reading afterwards: each round is a defect the run's own
review gates let through.

```json
{
  "feature": "auth-hardening",
  "status": "promoted",
  "rounds": [
    {
      "ts": "2026-08-01T05:31:00.000Z",
      "phase": "quality",
      "attempt": 1,
      "committed": true,
      "findings": [{ "severity": "HIGH", "title": "…", "problem": "…", "fix": "…" }]
    }
  ]
}
```

On `escalated` the file also carries `escalationReason` and the `findings` that
caused it:

```json
{
  "feature": "auth-hardening",
  "status": "escalated",
  "url": "https://github.com/o/r/pull/42",
  "escalationReason": "spec review still reporting 3 finding(s) after 3 fix attempts.",
  "findings": [{ "severity": "HIGH", "title": "…", "problem": "…", "fix": "…" }]
}
```

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
      "notify": { "mode": "escalation" },
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
| `defaultAgent` | `agent.default` | acpx agent for any node without a pinned profile. Unset → the agent the run used, never acpx's own default. |
| `model` | `null` | acpx `--model` — a run-wide model *floor*. Opt-in; see [Pinning the model](#pinning-the-model). |
| `reviewers.spec` | `null` | acpx agent profile for the spec-review phase — see §4. |
| `reviewers.quality` | `null` | acpx agent profile for the quality-review phase. |
| `escalate.telegram` | `true` | Prefer Telegram for escalations when credentials resolve; else PR/MR comment. |
| `notify.mode` | `"escalation"` | Terminal notification policy: `escalation` preserves escalation-only behavior, `always` also reports success/failure, and `off` disables Telegram notifications. |
| `timeouts.acceptanceMs` | 600000 (10 min) | Cap per acceptance-test group, in both the `acceptance` node and gate zero of `quality_gates`. |
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
3. else **`agent.default` — the agent the run itself used**

Step 3 is the important one. Setting only `reviewers` used to leave
`--default-agent` off the argv entirely, so acpx fell back to its *own* default:
the reviewers ran on the models you named, and every `fix_*` node — the nodes
that actually edit your code — ran on whatever acpx happened to be configured
with. The flow now inherits the run's agent instead, so a profile that
configures only reviewers behaves the way it reads.

Fix nodes (`fix_acceptance`, `fix_spec`, `fix_quality`, `fix_gate`) are never
pinned — they always use the default agent.

### Pinning the model

`agent.default` and `defaultAgent` name an **agent**, never a model. In acpx an
agent entry carries its own model, so that is where the model normally lives:

```json
// ~/.acpx/config.json
"nax-quality-reviewer-codex": {
  "argv": ["npx", "-y", "@agentclientprotocol/codex-acp@^1.1.5"],
  "model": "gpt-5.6-terra"
}
```

acpx resolves each node's model as:

```
node.model  ??  agent.model  ??  --model
```

`finish.autoFlow.model` supplies that last term. It is a **floor, not an
override**: a reviewer pinned to an agent entry that names its own model keeps
that model, and `--model` reaches only the nodes with nothing above it — in
practice the `fix_*` nodes.

```json
"finish": { "autoFlow": {
  "defaultAgent": "claude",
  "model": "sonnet",
  "reviewers": { "spec": "nax-spec-reviewer-codex", "quality": "nax-quality-reviewer-codex" }
}}
```

> **Requires an acpx that reads `model` from agent entries.** That precedence is
> what keeps `--model` from reaching your reviewers. On a build without it,
> `agent.model` is always absent, `--model` becomes the only model signal, and it
> *would* override the reviewers. This is why the key defaults to `null` and is
> never derived from `config.models` — leave it unset and the argv is unchanged.

A run's own `config.models[agent][tier]` is **not** consulted here. That map is
tier-keyed and the flow has no tier, so nax does not guess one for you.

Verify a profile resolves before enabling the flow:

```bash
acpx nax-spec-reviewer 'reply with OK'
```

### How the profiles reach the flow

The plugin passes them as the env vars `NAX_FINISH_SPEC_PROFILE` and
`NAX_FINISH_QUALITY_PROFILE`, which the flow module reads at load time. You can
set them yourself when running the flow by hand (§6).

### Reviewer tier parity

`reviewers.spec` and `reviewers.quality` default to `null`, which means both
reviewer nodes inherit acpx's `--default-agent`. The `post-impl-review` skill, by
contrast, dispatches its quality worker on a reviewer-tuned agent type at the
invoking session's model. If you are comparing the two — or trusting the flow's
reviewers to match what the skill finds — pin the profiles explicitly:

```json
{ "finish": { "autoFlow": { "reviewers": { "spec": "reviewer", "quality": "code-reviewer" } } } }
```

An unpinned comparison measures model tier as much as it measures the flow.

---

## 5. Escalation

On anything needing human judgment the flow pushes what it fixed and sends a
"needs judgment" summary naming the reason and the findings.

Escalation is decided per finding, not per phase. A reviewer marks a finding
`Judgment: yes — <why>` when it is a spec conflict or a design call with no safe
mechanical fix; only those halt the flow. Everything else is fixed and
re-verified. This is deliberate: the quality dimension runs at a >=60% confidence
bar specifically to surface design and maintainability concerns, and a
whole-phase escalate route made reporting one of those equivalent to stopping the
pipeline.

`Judgment: yes` (reviewer-authored, escalates to a human) and `## DISPOSITIONS
… rejected` (fixer-authored, rejects a finding on cited evidence — see [What a
fix node can reject](#what-a-fix-node-can-reject)) are two distinct markers
scoped to different nodes; neither substitutes for the other.

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
opens no draft to hold one. The message names each finding by severity and
title, not just the count, and is truncated to the Bot API's 4096-char limit
(saying how many it dropped). It is sent as plain text — review titles carry
backticks and underscores that Markdown parsing would reject outright.

**PR/MR comment (fallback).** With `escalate.telegram: false`, or no credentials,
the flow comments on the branch's existing PR/MR — opening a *draft* to hold the
comment only if none exists. It never opens a ready PR while escalating.

**Terminal notification policy.** `notify.mode: "always"` sends a best-effort Telegram report for every
non-escalation terminal result and for flow crashes. A rejected or failed ordinary notification is logged but does
not change the action result. Escalation delivery keeps its stronger guarantee: when Telegram is the selected
escalation channel, a failed send is reported as an undelivered escalation. `notify.mode: "off"` forces escalation
through the PR/MR-comment fallback so disabling Telegram cannot silently suppress both channels.

**Delivery is never fatal.** The result file is written *before* delivery is
attempted, so a rate limit, an expired token or an unrecognised remote cannot
lose the escalation. A failed delivery is recorded as `deliveryError` in the
result, logged, and reported by the plugin as `escalated but undelivered` —
Telegram still fires, because the plugin sends from the result file.

**Forge detection** matches the remote's *host*, so self-hosted instances
(`gitlab.mycorp.com`, `github.mycorp.com`) work. For an enterprise host naming
neither forge (`git.corp.com`), it falls back to whichever of `gh` / `glab` is
installed, and only errors when that is ambiguous too.

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
| A review escalated with "never discharged its reading obligations" | The reviewer returned findings but omitted `## TOUCHPOINTS` or `## WALK` twice, or listed touchpoint paths that do not exist in the repo. Its reply is in the acpx run bundle. This is working as designed — the alternative is a verdict with no evidence behind it being treated as an approval. |

---

## See also

- [configuration.md](./configuration.md) — the `finish.autoFlow` key reference
- [triggers.md](./triggers.md) — other post-run hooks
- `flows/nax-finish/` — the flow module itself
