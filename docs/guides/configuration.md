---
title: Configuration
description: How to configure nax
---

## Configuration

Config is layered — project overrides global:

| File | Scope |
|:-----|:------|
| `~/.nax/config.json` | Global (all projects) |
| `.nax/config.json` | Project-level override |

**Key options:**

```json
{
  "execution": {
    "maxIterations": 20,
    "costLimit": 5.0
  },
  "tdd": {
    "strategy": "auto"
  },
  "routing": {
    "strategy": "keyword"
  },
  "quality": {
    "commands": {
      "test": "bun test test/ --timeout=60000",
      "testScoped": "bun test --timeout=60000 {{files}}",
      "lint": "bun run lint",
      "typecheck": "bun x tsc --noEmit",
      "lintFix": "bun x biome check --fix src/",
      "formatFix": "bun x biome format --write src/"
    }
  }
}
```

### Agent Configuration

<a name="agent-configuration"></a>

The `agent` block is the canonical source of truth for agent selection and availability fallback (ADR-012). It consolidates three legacy configs (`autoMode.defaultAgent`, `autoMode.fallbackOrder`, `context.v2.fallback`) into a single shape.

```json
{
  "agent": {
    "protocol": "acp",
    "default": "claude",
    "maxInteractionTurns": 20,
    "fallback": {
      "enabled": true,
      "map": {
        "claude": ["codex", "opencode"],
        "codex": ["claude"]
      },
      "maxHopsPerStory": 2,
      "rebuildContext": true,
      "onQualityFailure": false
    }
  }
}
```

| Key | Default | Description |
|:----|:--------|:------------|
| `agent.protocol` | `"acp"` | Transport protocol — `"acp"` (spawns an agent CLI via acpx), `"native"` (nax drives the model directly), or `"hybrid"`. A capability gate, not a router. |
| `agent.default` | `"claude"` | Primary agent. Read via `resolveDefaultAgent(config)` / `ctx.agentManager.getDefault()`. |
| `agent.maxInteractionTurns` | `20` | Max turns per agent session. |
| `agent.fallback.enabled` | `false` | Master switch for availability fallback (auth / rate-limit / service-down). |
| `agent.fallback.map` | `{}` | Keyed map — `{ primary: [next, ...] }`. Walked by `AgentManager.nextCandidate()`. |
| `agent.fallback.maxHopsPerStory` | `2` | Swap ceiling per story. Prevents runaway swap loops. |
| `agent.fallback.rebuildContext` | `true` | Call `ContextOrchestrator.rebuildForAgent()` on swap so the new agent sees a re-rendered bundle. |
| `agent.fallback.onQualityFailure` | `false` | Also swap on review / verify reject, not just availability. Use with care — often masks real regressions. |
| `agent.acp.promptRetries` | `0` | ACP only. Becomes acpx's `--prompt-retries`; the retry runs inside the spawned agent process. |
| `agent.native.transportRetry.maxAttempts` | `3` | Native only. Total attempts for one round trip when the provider stalls or reports itself overloaded. `1` disables retry. |
| `agent.native.transportRetry.baseDelayMs` | `2000` | Native only. Equal-jitter exponential backoff base, capped by the turn's remaining budget. |

**Scope — what this controls.** Only the *availability* retry layer (auth / 429 / service down). Transport retries (broken socket, stale session) stay on the same agent inside the adapter. Agent-internal retries (a stalled stream or a 502/503 inside one call) stay on the same agent too, in the spawned agent process on ACP and in the native turn loop on native — see `agent.acp.promptRetries` and `agent.native.transportRetry` above. Payload-shape retries (JSON parse fail) stay on the same agent inside the caller. See [Agents — How fallback works](agents.md#how-fallback-works) for the full split.

**Legacy keys are rejected, not stripped.** `autoMode.defaultAgent`, `autoMode.fallbackOrder`, and `context.v2.fallback` were removed in ADR-012 Phase 6. Loading a config with them throws `NaxError code: CONFIG_LEGACY_AGENT_KEYS` with a migration hint. This is intentional — silently stripping would mask the migration.

---

### Shell Operators in Commands

Review commands (`lint`, `typecheck`) are executed directly via `Bun.spawn` — **not** through a shell. This means shell operators like `&&`, `||`, `;`, and `|` are passed as literal arguments and will not work as expected.

**❌ This will NOT work:**
```json
"typecheck": "bun run build && bun run typecheck"
```

**✅ Workaround — wrap in a `package.json` script:**
```json
// package.json
"scripts": {
  "build-and-check": "bun run build && bun run typecheck"
}
```
```json
// .nax/config.json
"quality": {
  "commands": {
    "typecheck": "bun run build-and-check"
  }
}
```

This limitation applies to all `quality.commands` entries (`test`, `lint`, `typecheck`, `lintFix`, `formatFix`).

---

### Scoped Test Command

By default, nax runs scoped tests (per-story verification) by appending discovered test files to the `test` command. This can produce incorrect commands when the base command includes a directory path (e.g. `bun test test/`), since the path is not replaced — it is appended alongside it.

Use `testScoped` to define the exact scoped test command with a `{{files}}` placeholder:

| Runner | `test` | `testScoped` |
|:-------|:-------|:-------------|
| Bun | `bun test test/ --timeout=60000` | `bun test --timeout=60000 {{files}}` |
| Jest | `npx jest` | `npx jest -- {{files}}` |
| pytest | `pytest tests/` | `pytest {{files}}` |
| cargo | `cargo test` | `cargo test {{files}}` |
| go | `go test ./...` | `go test {{files}}` |

If `testScoped` is not configured, nax falls back to a heuristic that replaces the last path-like token in the `test` command. **Recommended:** always configure `testScoped` explicitly to avoid surprises.

**TDD strategy options:** <a name="tdd-strategy-options"></a>

| Value | Behaviour |
|:------|:----------|
| `auto` | nax decides based on complexity and tags — simple→`tdd-simple`, security/public-api→`three-session-tdd`, else→`three-session-tdd-lite` |
| `strict` | Always use `three-session-tdd` (strictest — all stories) |
| `lite` | Always use `three-session-tdd-lite` |
| `off` | No TDD — tests written after implementation (`test-after`) |

---

### Routing

Controls how nax classifies story complexity and selects model tier + test strategy.

```json
{
  "routing": {
    "strategy": "keyword"
  }
}
```

**Routing strategy options:** <a name="routing-strategy-options"></a>

| Value | Behaviour |
|:------|:----------|
| `"keyword"` | **Default.** Fast, free, deterministic — classifies by keywords in title/description/tags. No API calls. |
| `"llm"` | Uses the configured LLM to classify complexity. Better accuracy for ambiguous stories. Requires an agent to be configured. |

**Priority order (regardless of strategy):**

1. **PRD routing (always wins)** — if a story has `routing.complexity` and `routing.testStrategy` set in `prd.json`, all other routing is skipped
2. **Plugin routers** — registered plugins can override routing per-story
3. **Strategy fallback** — keyword or LLM depending on `routing.strategy`

> **In practice, PRD routing always wins.** `nax plan` generates `routing.complexity`, `routing.testStrategy`, and `routing.reasoning` for every story in the PRD. Since `resolveRouting()` returns early when these fields are present, the plugin → LLM → keyword chain only fires for hand-written PRDs that omit routing fields.

**Per-story routing in PRD (set by `nax plan`):**

```json
{
  "userStories": [
    {
      "id": "US-001",
      "routing": {
        "complexity": "complex",
        "testStrategy": "three-session-tdd",
        "reasoning": "security-critical: auth, jwt"
      }
    }
  ]
}
```

You can manually edit these fields in `prd.json` to override the plan agent's routing decisions before running `nax run`.

**Fallback routing (for hand-written PRDs without routing fields):**

The `routing.strategy` config controls how stories are classified when PRD routing is absent:

```json
{
  "routing": {
    "strategy": "keyword"
  }
}
```

**Opting into LLM fallback routing:**

```json
{
  "routing": {
    "strategy": "llm",
    "llm": {
      "model": "fast",
      "fallbackToKeywords": true,
      "mode": "hybrid"
    }
  }
}
```

> **Note:** LLM routing requires an agent (e.g. `claude`) to be installed and configured. It makes real API calls, which incur cost and latency. For CI or contributor environments, prefer `"keyword"`.

---

### Project Language & Type

Auto-detects your project's language, type, test framework, and lint tool from manifest files. All fields are optional — omit a field to let nax detect it.

```json
{
  "project": {
    "language": "typescript",
    "type": "api",
    "testFramework": "vitest",
    "lintTool": "biome"
  }
}
```

| Field | Auto-detected from | Values |
|:------|:-------------------|:-------|
| `language` | `go.mod`, `Cargo.toml`, `pyproject.toml`, `package.json` | `typescript`, `javascript`, `go`, `rust`, `python` |
| `type` | `package.json` `workspaces`, deps, `bin` field | `monorepo`, `web`, `api`, `cli`, `tui` |
| `testFramework` | Language + dev dependencies | `go-test`, `cargo-test`, `pytest`, `vitest`, `jest` |
| `lintTool` | Language + config files | `golangci-lint`, `clippy`, `ruff`, `biome`, `eslint` |

**Explicit config overrides auto-detection.** Only the fields you set are locked; others are still auto-detected.

See [Language & Project-Type Awareness](language-awareness.md) for full details.

---

### Semantic Review Diff Mode

Controls how the production diff is provided to the semantic reviewer:

```json
{
  "review": {
    "semantic": {
      "diffMode": "ref",
      "resetRefOnRerun": false
    }
  }
}
```

| Value | Behaviour |
|:------|:----------|
| `"ref"` (default) | Reviewer self-serves via git tools. No diff cap. Better for large changes and multi-tier retries. |
| `"embedded"` | Diff is inlined in the prompt (~50KB cap). Simple, but can lose context in large stories. |

`resetRefOnRerun`: when `true`, clears `storyGitRef` on re-run so it is re-captured fresh. Default: `false`.

---

### Adversarial Review

LLM-based adversarial code review that asks "Where does this break?" rather than "Does this satisfy the ACs?":

```json
{
  "review": {
    "checks": ["typecheck", "lint", "semantic", "adversarial"],
    "adversarial": {
      "modelTier": "balanced",
      "diffMode": "ref",
      "rules": [],
      "timeoutMs": 600000,
      "excludePatterns": [],
      "parallel": false,
      "maxConcurrentSessions": 2
    }
  }
}
```

| Key | Default | Description |
|:----|:--------|:-----------|
| `modelTier` | `"balanced"` | Model tier for the adversarial reviewer (`"fast"`, `"balanced"`, `"powerful"`) |
| `diffMode` | `"ref"` | How the diff is provided: `"embedded"` (inlined, ~50KB cap) or `"ref"` (self-serve via git tools, no cap) |
| `rules` | `[]` | Project-specific rules passed verbatim to the adversarial prompt |
| `timeoutMs` | `600000` | Session timeout in milliseconds (600s matches semantic review timeout) |
| `excludePatterns` | `[]` | Git pathspec patterns to exclude from the diff |
| `parallel` | `false` | When `true`, semantic and adversarial reviews run concurrently instead of sequentially |
| `maxConcurrentSessions` | `2` | Maximum concurrent LLM review sessions when `parallel: true`. Higher values use more LLM quota but complete faster. |

See [Semantic Review — Adversarial Review](semantic-review.md#adversarial-review-review-003) for details.

---

### Session Error Retries

Controls how many times the ACP adapter retries on session errors:

```json
{
  "execution": {
    "sessionErrorMaxRetries": 1,
    "sessionErrorRetryableMaxRetries": 3
  }
}
```

| Field | Default | Description |
|:------|:--------|:------------|
| `sessionErrorMaxRetries` | `1` | Retries for non-retryable session errors (stale/locked) |
| `sessionErrorRetryableMaxRetries` | `3` | Retries for retryable errors (queue disconnect) |

---

### Story Isolation

Controls whether stories get their own git worktree in sequential mode:

```json
{
  "execution": {
    "storyIsolation": "worktree"
  }
}
```

| Value | Behaviour |
|:------|:----------|
| `"shared"` (default) | Stories execute in the main working directory |
| `"worktree"` | Each story gets an isolated git worktree (EXEC-002) |

See [Parallel Execution — Sequential Worktree Isolation](parallel-execution.md#sequential-worktree-isolation-exec-002) for details.

---

### Rectification Escalation

When rectification retries are exhausted at the current model tier, nax can escalate to the next tier for one additional attempt before escalating the story.

```json
{
  "execution": {
    "rectification": {
      "escalateOnExhaustion": true
    }
  }
}
```

| Value | Behaviour |
|:-------|:----------|
| `true` | After `maxRetries` at the current tier, retry once at the next tier (fast→balanced→powerful). Last resort before escalating the story. |
| `false` | Escalate the story immediately after `maxRetries` at current tier. |

**Requires `autoMode.escalation.enabled: true`.**

---

### Build Command

The `build` command is used by the review stage to catch compilation or build errors that typecheck alone might miss.

```json
{
  "quality": {
    "commands": {
      "build": "bun run build"
    }
  }
}
```

Add `"build"` to `review.checks` to include it in the review pipeline:

```json
{
  "review": {
    "checks": ["typecheck", "lint", "build"]
  }
}
```

See [Semantic Review](semantic-review.md) for the behavioral review check.

---

### Autofix Budget

Control how many agent rectification attempts nax makes when review checks fail:

```json
{
  "quality": {
    "autofix": {
      "enabled": true,
      "maxAttempts": 2,
      "maxTotalAttempts": 10
    }
  }
}
```

| Field | Default | Description |
|:------|:--------|:------------|
| `enabled` | `true` | Master switch for autofix |
| `maxAttempts` | `2` | Max agent rectification attempts per review→autofix cycle |
| `maxTotalAttempts` | `10` | Global ceiling per story across all review→autofix cycles |

**How it works:** When review fails, autofix spawns an agent up to `maxAttempts` times per cycle. If the agent fixes the issue but a subsequent review fails again, a new cycle starts. `maxTotalAttempts` caps the total agent spawns across all cycles to prevent runaway loops.

Example with defaults: a story can cycle through review→autofix up to 5 times (5 × 2 = 10 spawns) before hitting the global ceiling and escalating.

---

### Mutation Spot-Check

Green tests prove the code passes the suite; they do not prove the suite would notice if the code were wrong. The mutation spot-check injects a small number of deliberate defects into the story's changed source files, re-runs the scoped tests against each one, and reports any mutant the suite failed to catch.

It is **opt-in and advisory** — it runs after `full-suite-gate` and can never fail a story. Every mutation is reverted in a `finally`, so the worktree is restored even if a test run throws.

```json
{
  "execution": {
    "mutationCheck": {
      "enabled": true,
      "maxMutants": 3,
      "timeoutSeconds": 60
    }
  }
}
```

| Field | Default | Description |
|:------|:--------|:------------|
| `enabled` | `false` | Master switch. When `false` the phase is not even scheduled. |
| `maxMutants` | `3` | Mutants tested per story (1–50). Candidates are gathered across **all** changed files, then sampled evenly across that list — so raising this widens coverage rather than digging deeper into the first file. |
| `timeoutSeconds` | `60` | Per-mutant scoped test-run timeout (5–600). |

**Cost:** one scoped test run per mutant, serially. Worst case adds `maxMutants × timeoutSeconds` to a story — 3 minutes at the defaults.

**Operators** are regex-based and language-scoped, four per language: comparison flips (`==`↔`!=`, `>=`↔`<=`, and whitespace-delimited `>`/`<`), boolean-literal flips, and whitespace-delimited arithmetic flips (`+`↔`-`, `*`↔`/`). Supported languages: `typescript`, `javascript`, `python`, `go`, `rust`. Any other language yields no operators and the check is a no-op. The whitespace gating is deliberate — it keeps the mutator away from module specifiers (`"../config"`), URLs, generics (`Array<string>`), and arrow functions, all of which would otherwise produce mutants that merely fail to compile.

**Outcomes** are counted per story as `killed` / `survived` / `errored`:

| Outcome | Meaning |
|:--------|:--------|
| `killed` | Tests ran and failed — the suite caught the defect. Requires evidence the tests actually executed (a non-zero pass/fail tally), so a mutant that fails to build is never miscounted as a kill. |
| `survived` | Tests ran and passed with the defect in place — **a gap in the suite.** |
| `errored` | The mutant never produced a real test result (build failure, unresolvable module, unparseable runner output, timeout). Discarded, not a signal about test quality. |

Survivors are logged per story, and in headless mode (non-`json`) a `SURVIVING MUTANTS` block is printed at run end listing `storyId  file:line  operatorId`:

```
SURVIVING MUTANTS
  US-002  src/config/merge.ts:88  ts:cmp-flip
```

Treat each line as "this line's behaviour is not pinned by a test" and decide whether it deserves one.

**Restoring the worktree.** A `finally` covers a thrown error but not process death, so each mutation is also journalled to `.nax/mutation-journal/<storyId>.json` *before* it is written to disk, and the entry is removed only once the revert is confirmed. If a run is interrupted — Ctrl+C, SIGKILL, a crash, a lost machine — the next run sweeps the journal and undoes anything left behind, whether or not the check is still enabled.

The journal is anchored to the **working tree** (the git root of `workdir`), not the project root, so in parallel mode each git worktree keeps its own and concurrent stories cannot restore each other's in-flight mutations. A sweep also skips any entry naming a file outside its own tree. `nax init` adds `.nax/mutation-journal/` to `.gitignore` and it is written to `.git/info/exclude` for every worktree — nax auto-commits with `git add -A`, so an un-ignored journal would land in the feature branch.

Reverting is verified, never positional: the line must still hold the exact mutant that was written. If something else rewrote it in the meantime (a formatter, codegen, the agent), nax writes nothing — restoring a stale line over content it cannot account for is the one outcome nothing downstream can undo. It logs the file, line, and what it actually found, stops mutating that story, and prints a final block:

```
WORKTREE NOT RESTORED — a mutation may still be applied; check the log for file and line
  US-002
```

That block means **check your working tree**. It is the only mutation-check output that is about your files rather than your tests.

---

### Monorepo Acceptance Test Exclusion

nax generates per-package acceptance test files at `<package-root>/.nax-acceptance.test.ts`. These files are meant to be run by nax only — **not** by your regular test suite.

**Add to `.gitignore`:**

```
**/.nax-acceptance*
```

**Exclude from jest/vitest per-package config:**

For monorepo projects using jest or vitest, add to each package's test config to prevent `.nax-acceptance.test.ts` from running during `npm test` / `npx turbo test`:

```js
// jest.config.js or vitest.config.ts
testPathIgnorePatterns: [".nax-acceptance"]
// or for vitest:
exclude: ["**/.nax-acceptance*"]
```

**Why this matters:** the acceptance test files import production code with relative paths (e.g. `./src/utils/detect-provider.ts`). They run correctly from their package directory under nax control, but should be excluded from the normal test pipeline to avoid unexpected failures or duplicate runs.

### Autonomous Finish (`finish`)

After a **successful** run on a feature branch, nax can drive the whole finish
ritual — acceptance gate, spec review, quality review, repo-root quality gates,
PR — without a human in the terminal, as an in-process post-run phase (no
subprocess, no external flow file). It auto-fixes what it can, and on anything
needing human judgment it **stops and escalates** instead of guessing. It
never merges.

**Opt-in — off by default:**

```json
{
  "finish": {
    "enabled": true,
    "reviewers": { "spec": "balanced", "quality": "balanced" },
    "escalate": { "telegram": true },
    "notify": { "mode": "escalation" },
    "rerun": "on-change",
    "timeouts": { "acceptanceMs": 600000, "gateMs": 900000, "flowMs": 5400000 }
  }
}
```

| Key | Default | Meaning |
|:---|:---|:---|
| `enabled` | `false` | Master gate. Finish never fires unless this is true. |
| `narrative` | `true` | Whether the phase spends an agent turn writing the PR body's "What changed" section. Disabled → the body carries the mechanical fallback (spec Summary) or no such section. |
| `prBody.template` | `"merge"` | How the repo's own PR/MR template is honoured: `merge` fills matching headings and drops the rest, `strict` keeps unfillable headings empty, `ignore` skips the template entirely. |
| `prBody.sectionMap` | `{}` | Template heading → body-section key overrides, layered over the defaults in `src/forge/template-merge.ts`. Known keys: `narrative`, `stories`, `verification`, `rounds`, `outOfScope`. |
| `reviewers.spec` / `reviewers.quality` / `reviewers.narrative` / `reviewers.fix` | `null` | A model tier name (e.g. `"balanced"`) or `{ agent, model }` object, resolved the same way every other operation's model is. `null` falls through to the op's own default. |
| `escalate.telegram` | `true` | Prefer Telegram for escalations when `interaction.plugin` is `telegram` (or `NAX_TELEGRAM_TOKEN` + `NAX_TELEGRAM_CHAT_ID` are set). With no credentials it falls back to a PR/MR comment. |
| `notify.mode` | `"escalation"` | `escalation` preserves escalation-only reporting; `always` also reports clean outcomes and crashes; `off` disables Telegram and uses the escalation comment fallback. |
| `rerun` | `"on-change"` | Cross-run idempotency. `on-change` skips the whole phase when the finish ledger's branch/HEAD already match a terminal outcome (opened/promoted/already-ready/escalated) from a previous run — a re-run on an unchanged branch costs one `git rev-parse`, not a repeat of every review and gate. `always` bypasses the ledger and re-runs the phase every time, matching pre-ledger behaviour. |
| `timeouts.acceptanceMs` | 10 min | Cap per acceptance-test group. |
| `timeouts.gateMs` | 15 min | Cap per quality gate (build / typecheck / lint / test). |
| `timeouts.flowMs` | 90 min | Whole-phase deadline, enforced as an `AbortSignal`. |
| `timeouts.stepMs` | `null` | Cap per LLM op (one review, fix or narrative turn). `null` keeps the op's own default. |

**It runs only when** the run succeeded (no failed or paused stories, at least
one completed), HEAD is not `main`/`master`, and `enabled` is true.

**Requirements:** `quality.commands` must be configured — the phase runs those
commands at the repo root as its final gate. With none configured it escalates
rather than opening a PR, because a green gate that verified nothing is worse
than no gate. `gh` or `glab` must be authenticated for the PR/MR step.

**What it does with what it finds:**

| Outcome | Action |
|:---|:---|
| Everything green | Opens a **ready** PR/MR, or promotes the draft `autoPR` already opened. Never merges. |
| Findings with a clear recommended fix | Applies them, re-runs acceptance / re-reviews, up to 3 attempts per phase. |
| Spec conflicts, contradictions, design calls, or anything it can't get green | Commits and pushes what it fixed, then escalates via Telegram or a PR/MR comment. No ready PR. |
| Branch has no commits ahead of base | Reports `nothing-to-finish` and stops. |
| Branch/HEAD already match a terminal outcome from a previous finish (`rerun: "on-change"`, the default) | Skips the phase entirely, logs it, and records `status: "skipped"` — see `rerun` above. |
| The branch's PR/MR is already **merged** | Reports `nothing-to-finish` with `reason: "pr-merged"` and stops, rather than reviewing, committing onto a merged branch and rewriting the merged PR's body. |
| The branch's PR/MR is **closed without being merged** | Escalates, and is the one escalation that does **not** commit and push first — nothing has run yet, and pushing to a closed PR's branch can recreate a head branch the forge deleted when the human closed it. Reopening the PR is not a decision the fix loop makes on its own. |

Both forge checks fail open: no PR yet, an unauthenticated or missing `gh` /
`glab`, an undetected forge, a CLI that cannot be spawned, and any response
that is not a JSON object all leave the phase running as normal. A missed
check costs one redundant finish run; a wrong one would abandon a branch that
still had work to finish.

The phase's audit trail — one line per fix round, plus the terminal state — is
written to `~/.nax/<project>/finish-audit/<feature>/`, beside `prompt-audit/`
and `review-audit/`. That directory also holds `last.json`, the cross-run
ledger `rerun: "on-change"` reads on entry: the most recent terminal result's
branch, HEAD sha, status and PR url.

**Migrating from `finish.autoFlow`:** the old acpx-subprocess flow was removed
along with `flowPath` and `defaultAgent` — those two keys, plus `model`, are
now pure no-ops and only produce a deprecation warning if still present. Move
your keys from `finish.autoFlow.*` up to `finish.*`; `reviewers.*` used to
take acpx profile names and now takes a model tier or `{ agent, model }`
object, so a leftover profile-name string is mapped to `null` (falling back
to the default model selection) rather than rejected.

The interactive, approval-gated `nax-finish` skill still exists for manual
finishes — this is the autonomous path, not a replacement.
