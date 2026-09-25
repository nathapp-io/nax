---
title: Semantic Review
description: LLM-based behavioral review against story acceptance criteria
---

## Semantic Review

Semantic review uses an LLM to compare the actual git diff against a story's acceptance criteria (ACs). Unlike lint or typecheck (which validate syntax and types), semantic review validates **behavior** — checking that the implementation actually satisfies what the story asked for.

**Status:** Built-in (v0.54.0) — opt-in via config.

---

## How It Works

```
Story ACs + production diff → LLM prompt → { passed: bool, findings: [...] }
```

1. Collects the git diff from the story's starting commit to `HEAD` (**production code only** — test files excluded)
2. Builds a prompt containing the story title, description, and ACs
3. Calls the LLM to verify each AC is correctly implemented
4. Parses the structured JSON response and reports findings

Semantic review runs **after** the story passes all other checks (typecheck, lint, test). It is a final behavioral gate.

---

## What Semantic Review Checks

Semantic review verifies **acceptance criteria implementation**:

1. **AC coverage** — each acceptance criterion is implemented, not partially or missing
2. **AC correctness** — the implementation does what the AC specifies, not something different
3. **Dead code** — new code with stubs, noops, or unreachable branches
4. **Wiring** — new functions/classes are exported and called by their callers

Each finding carries one category from a closed taxonomy: `unimplemented`, `partial`, `contradiction`, `dead-path`, `unwired`, `other` (an unknown category normalizes to `other`).

Semantic review does **NOT** check:

- Style, naming, or formatting (handled by lint)
- Import ordering or file length (handled by lint)
- Type correctness (handled by typecheck)
- Test quality or test conventions (handled by lint)

---

## Test File Exclusion

Test files and nax metadata are **excluded from the diff** sent to the LLM via configurable git pathspec patterns. With no `review` block in your config, the built-in default is the list below — common test directory conventions across languages, plus `.nax/` metadata that would otherwise consume the diff budget. If you configure `review.semantic` but leave `excludePatterns` unset, the patterns are instead derived from the project's resolved test-file patterns plus well-known noise directories (ADR-009):

```json
{
  "review": {
    "semantic": {
      "excludePatterns": [":!test/", ":!tests/", ":!*_test.go", ":!*.test.ts", ":!*.spec.ts", ":!**/__tests__/", ":!.nax/", ":!.nax-pids"]
    }
  }
}
```

Override for your project's test layout:

```json
{
  "review": {
    "semantic": {
      "excludePatterns": [":!src/test/", ":!*Test.java", ":!*_test.py", ":!test_*.py"]
    }
  }
}
```

Set to `[]` to include test files in the review.

This is intentional — semantic review validates production behavior against ACs. Test style and conventions are enforced by lint.

The `git diff --stat` summary (shown on truncation) still includes all files for full context.

---

## Enabling Semantic Review

Add `"semantic"` to `review.checks` in `.nax/config.json`:

```json
{
  "review": {
    "enabled": true,
    "checks": ["typecheck", "lint", "semantic"]
  }
}
```

---

## Configuration

```json
{
  "review": {
    "blockingThreshold": "error",
    "parseRetryMaxAttempts": 3,
    "semantic": {
      "model": "balanced",
      "diffMode": "ref",
      "resetRefOnRerun": false,
      "rules": [],
      "timeoutMs": 600000,
      "demandInspectionTrail": true,
      "acRegroundOnDrop": true,
      "substantiation": { "requote": true, "maxRequotes": 5 },
      "recurrenceDemotion": { "enabled": false, "maxBlockingRounds": 2, "maxAdvisoryRounds": 2 }
    }
  }
}
```

The values above are the defaults.

### `model`

Controls which model runs the semantic review. Accepts a tier string — `"fast"` (haiku), `"balanced"` (sonnet), `"powerful"` (opus) — or a `{ agent, model }` cross-agent pin. Default: `"balanced"`.

**Recommendation:** Use `"fast"` (haiku) for most projects — semantic review is a lightweight behavioral check, not a deep reasoning task.

### `diffMode` (REVIEW-002)

Controls how the production diff is provided to the reviewer:

| Mode | Description | Diff cap | Best for |
|:-----|:-----------|:---------|:---------|
| `"ref"` (default) | Reviewer self-serves via git tools (READ, GREP) | No cap | Large diffs, multi-tier retries |
| `"embedded"` | Diff is inlined directly in the prompt | ~50KB | Small-to-medium diffs, simple review |

In `"ref"` mode, the reviewer receives the story's `storyGitRef` and uses git commands to inspect the diff on demand. This removes the 50KB cap and lets the reviewer focus on specific files rather than scanning the entire diff.

### `resetRefOnRerun`

When `true`, clears `storyGitRef` on re-run so it is re-captured in the fresh execution. Default: `false`.

### Other semantic keys

| Key | Default | Effect |
|:----|:--------|:-------|
| `timeoutMs` | `600000` | Reviewer call timeout |
| `demandInspectionTrail` | `true` | In ref mode, a `passed: true` with no findings and no declared `inspectedFiles` gets one same-session re-prompt demanding the reviewer actually open the code |
| `acRegroundOnDrop` | `true` | If every blocking finding was dropped by AC-grounding, re-prompt once asking the reviewer to re-ground findings against the AC text |
| `substantiation.requote` / `maxRequotes` | `true` / `5` | When a finding's quoted evidence doesn't match disk, ask the same session for a verbatim requote before downgrading it |
| `recurrenceDemotion.enabled` | `false` | Opt-in: an error finding whose fingerprint keeps recurring blocks for at most `maxBlockingRounds` rounds, then demotes to advisory |

### Review-level keys

| Key | Default | Effect |
|:----|:--------|:-------|
| `review.blockingThreshold` | `"error"` | Minimum severity that blocks for semantic/adversarial findings (`error`, `warning`, `info`); lower severities are advisory |
| `review.parseRetryMaxAttempts` | `3` | Total attempts (initial call + corrective re-prompts) before the fail-open / fail-closed fallback below |
| `review.audit.enabled` | `false` | Write reviewer audit files (see below) |
| `review.nonBlockingFix` | unset | Best-effort fix pass for advisory findings (ADR-024); `sources` defaults to `["adversarial"]`, add `"semantic"` to seed it from semantic findings too |

### Custom Rules

Append project-specific rules to the default set:

```json
{
  "review": {
    "semantic": {
      "model": "fast",
      "rules": [
        "All public APIs must have JSDoc comments",
        "Error responses must use the project's standard error shape"
      ]
    }
  }
}
```

Rules are passed verbatim to the LLM prompt as additional evaluation criteria.

---

## Plugin Mode

Built-in semantic and adversarial review run **per story** as ops in the story orchestrator's `CANONICAL_ORDER` (`semantic-review` / `adversarial-review` phases). They are not affected by `review.pluginMode`.

`review.pluginMode` controls only `IReviewPlugin` reviewers, which run as a **deferred end-of-run** pass (per-story plugin gating was removed — ADR-023 / #1146):

```json
{
  "review": {
    "pluginMode": "observational"
  }
}
```

| Mode | Behaviour |
|:-----|:----------|
| `observational` (default) | Plugin reviewer failures are logged + surfaced in run status but do NOT fail the run |
| `gating` | Any failing plugin reviewer marks the run failed (`RunResult.success = false`) |

---

## Fail-Open / Fail-Closed Behavior

Unparseable reviewer output is re-prompted up to `review.parseRetryMaxAttempts` total attempts (default 3). If the budget is exhausted, semantic review **fails open** — the review passes, flagged `failOpen: true`. This prevents flaky LLM responses from blocking valid implementations.

**Exception:** If the last raw output contains `"passed": false`, the review **fails closed** (`looksLikeFail: true`) — the LLM clearly intended to fail the review but its output was malformed or cut off. Either way, a preview of the unparsed output is kept in the review audit (`unparsedPreview`).

---

## Diff Truncation

In `"embedded"` mode, production diffs are truncated to **~50 KB** (51,200 bytes) to stay within LLM context and reduce output truncation risk. When truncated, a `git diff --stat` summary (all files including tests) is prepended so the reviewer always knows which files changed.

```
## File Summary (all changed files)
 src/execution/parallel-batch.ts        | 200 +++
 src/execution/merge-conflict-rectify.ts |  45 +
 test/integration/parallel.test.ts      | 120 ++
 3 files changed, 365 insertions(+)

## Diff (truncated — 2/3 files shown)
...
```

Since test files are excluded from the diff, the 50KB budget goes entirely to production code — equivalent to ~100KB of mixed diff.

---

## Example Output

```
Semantic review failed:

[error] src/auth/login.ts:42 — AC-2 not implemented: catch block silently swallows login errors instead of returning error response
  Suggestion: Add error handling that returns the standard error shape per AC-2
[warn] src/auth/session.ts:18 — createSession() is defined but never called from the login flow
  Suggestion: Wire createSession() into the login handler after successful auth
```

---

## Mechanical vs LLM Check Splitting

The review runner classifies checks into two categories:

| Category | Checks | Runs when |
|:---------|:-------|:----------|
| **Mechanical** | `typecheck`, `lint`, `test`, `build` | Always (command-based, deterministic) |
| **LLM** | `semantic`, `adversarial` | After mechanical checks complete (sequenced by the story orchestrator) |

When mechanical checks fail but all LLM checks pass, `mechanicalFailedOnly: true` is set on the review result (`src/pipeline/types.ts`). This signals to the **fix cycle** that the code is functionally correct — the agent satisfied the acceptance criteria — but has fixable style or build issues. The cycle uses this to:

1. **Run the mechanical lint-fix strategy first** — attempt automated lint fixes before spawning an agent
2. **Suppress tier escalation** — if the agent reports `UNRESOLVED:` for a mechanical-only failure (e.g., lint errors in test files it cannot modify), it proceeds instead of escalating to a higher model tier

When `mechanicalFailedOnly` is `false` or `undefined`, normal escalation behavior applies.

---

## Review Audit Trail

When `review.audit.enabled` is true, every semantic and adversarial review writes a JSON audit file to `<outputDir>/review-audit/<featureName>/` (falling back to `<projectRoot>/.nax/review-audit/` when no output directory is known) so operators can inspect exactly what each reviewer decided, regardless of pass/fail.

### Directory Layout

```
<outputDir>/review-audit/
└── <featureName>/
    ├── 1718900000000-nax-abc12345-my-feature-US-001-reviewer-semantic.json
    └── 1718900001000-nax-abc12345-my-feature-US-001-reviewer-adversarial.json
```

### Audit Entry Fields

| Field | Description |
|:------|:-----------|
| `timestamp` | ISO 8601 timestamp of the audit write |
| `runId` | Run identifier |
| `storyId` | Story identifier for correlation |
| `featureName` | Feature name (determines subfolder) |
| `reviewer` | `"semantic"` or `"adversarial"` |
| `sessionName` | ACP session name — correlates with prompt-audit entries |
| `sessionId` | ACP volatile session ID, when the reviewer session opened |
| `recordId` | ACP stable record ID, when the reviewer session opened |
| `agentName` | Agent that ran the review |
| `parsed` | `true` if the LLM response parsed into valid review JSON |
| `looksLikeFail` | (only when `parsed: false`) Whether the raw response contained `"passed":false` |
| `failOpen` | Whether nax treated the reviewer failure as fail-open |
| `passed` | Final review decision after threshold handling |
| `blockingThreshold` | Severity threshold used for blocking vs advisory findings |
| `result` | Structured `{ passed, findings }` or `null` when parse failed |
| `modelPassed` | The reviewer's own verdict before nax's threshold handling (`null` when not declared) |
| `advisoryFindings`, `acks`, `acDropped` | Non-blocking findings, acknowledgements, and findings dropped by AC-grounding (`null` when absent) |
| `unparsedPreview` | (only when `parsed: false`) Preview of the output that defeated the parser |
| `noDispatch` | Whether the review ran without dispatching an agent (`null` when not declared) |
| `naxVersion`, `naxCommit` | nax build that wrote the entry |

### Behavior

- **Runtime-owned** — `NaxRuntime.reviewAuditor` captures reviewer session metadata and flushes on runtime close
- **Best-effort** — errors warn via the logger but never throw, so an audit failure cannot interrupt a run
- **Config gated** — audit files are written whenever semantic or adversarial review runs and `review.audit.enabled` is true

---

## Adversarial Review (REVIEW-003)

Adversarial review is a separate LLM-based review that complements semantic review. While semantic review asks "Does this satisfy the ACs?", adversarial review asks "Where does this break? What is missing?"

### Key Differences

| Aspect | Semantic | Adversarial |
|:-------|:---------|:------------|
| Question | Does this implement the ACs? | Where could this fail? |
| Session | Stateless reviewer (`reviewer-semantic`) | Own session (`reviewer-adversarial`) |
| Default diffMode | `"ref"` (no cap) | `"ref"` (no cap) |
| Findings | AC coverage, correctness | input handling, error paths, abandonment, test gaps, conventions, assumptions |

### Enabling

Add `"adversarial"` to `review.checks`:

```json
{
  "review": {
    "checks": ["typecheck", "lint", "semantic", "adversarial"],
    "adversarial": {
      "model": "balanced",
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

Beyond the keys shown, adversarial accepts `acRegroundOnDrop` (default `true`), `demandInspectionTrail` (default `true`), `substantiation` (requote/maxRequotes), and `recurrenceDemotion` — **enabled by default** for adversarial (`maxBlockingRounds: 2`), unlike semantic. `parallel: true` runs the semantic and adversarial reviewers concurrently, capped by `maxConcurrentSessions` (1–4).

### Finding Categories

Adversarial findings are categorized by the type of issue:

| Category | Description |
|:---------|:-----------|
| `input` | Missing input validation, boundary handling |
| `error-path` | Unhandled error conditions, swallowed exceptions |
| `abandonment` | Stubs, TODOs, partial implementations left behind |
| `test-gap` | Missing test coverage for critical paths |
| `convention` | Violations of project coding conventions |
| `assumption` | Load-bearing assumptions that could break under change |

### Scope-Aware Fix Routing

When adversarial review flags issues in test files, the **implementer session cannot fix them** — TDD isolation prevents the implementer from modifying tests. The fix cycle (`runFixCycle` in `src/findings/cycle.ts`, ADR-021/022) routes each canonical `Finding` to the right session role via its `fixTarget` field:

```
adversarial Finding[]
  ├── fixTarget: "source" → implementer/source fix strategy
  └── fixTarget: "test"   → test-writer fix strategy
```

**How it works:**

1. Each `Finding` carries `fixTarget` (`"source"` or `"test"`) reflecting where the fix lands, not what produced the finding (`src/findings/types.ts`). For adversarial findings the base lane comes from the category (`input`, `error-path`, `abandonment`, `assumption` → source; `test-gap`, `convention` → test), and a finding located in a test file is always moved to `"test"` (`src/review/category-fix-target.ts`).
2. `runFixCycle` dispatches findings to the matching `FixStrategy`; each strategy's predicate selects its findings (by source, category, `fixTarget`, or file pattern).
3. Test-targeted fixes use a test-writer session role; source-targeted fixes use the implementer session role — so each fix runs under the role permitted to modify the affected files.
4. Strategies run under dual budgets and the cycle exits when all active strategies are exhausted.

This ensures adversarial findings are routed to the session role that has permission to modify the affected files.

---

## Requirements

Semantic review requires a git history — it compares `${storyGitRef}..HEAD`. If the story's `storyGitRef` is missing or invalid, nax falls back to a merge-base ref (`getMergeBase`); if neither resolves, or the diff is empty, the check is skipped.

The LLM model must be configured in `models` for the chosen `model` tier.

---

## Behavior Matrix — Semantic Review

Semantic review runs as a single stateless LLM pass (`semanticReviewOp`). The dialogue / `ReviewerSession` path was removed (2026-05-29), and the debate panel path was removed with the debate subsystem (2026-09-20) — `review.dialogue.enabled` is a rejected legacy config key.

| Reviewer | Resolver |
|:---|:---|
| single reviewer via `agent.run()` or `agent.complete()` | N/A |
