---
title: Acceptance & Review End-to-End Flow
description: How acceptance testing, semantic review, debate, and diagnose/fix connect
---

## Acceptance & Review End-to-End Flow

This document maps how four subsystems connect across the nax pipeline:

1. **Acceptance test generation** — creates tests from acceptance criteria
2. **Semantic review** — LLM-verified behavioral check against ACs
3. **Adversarial review** — LLM-based adversarial code review (REVIEW-003)
4. **Acceptance loop** — post-run gate with diagnose/fix retry
5. **Debate** — optional multi-agent panel resolution for semantic review

---

## Pipeline Execution Order

```
PRD loaded (stories with acceptance criteria)
 │
 ├─ 1. ACCEPTANCE SETUP (pre-run pipeline)
 │   acceptanceSetupStage → acceptanceRefineOp + acceptanceGenerateOp
 │   ├─ AC fingerprinting (skip regen if unchanged)
 │   ├─ Optional AC refinement (LLM → testable criteria)
 │   ├─ Per-package test generation (monorepo-aware)
 │   └─ RED gate: tests must FAIL (proves they test new behavior)
 │   Output: ctx.acceptanceTestPaths[]
 │
 ├─ 2. STORY EXECUTION LOOP (per story)
 │   │
 │   ├─ ... implement, typecheck, lint, test ...
 │   │
 │   ├─ 3. REVIEW (semantic-review + adversarial-review phases of CANONICAL_ORDER)
 │   │   semanticReviewOp / adversarialReviewOp (src/operations/)
 │   │   ├─ SEMANTIC REVIEW (behavioral AC check)
 │   │   │   ├─ STATELESS (default) → agent.run() or agent.complete()
 │   │   │   └─ DEBATE (debate.stages.review.enabled) → N debaters + resolver
 │   │   │
 │   │   ├─ ADVERSARIAL REVIEW (REVIEW-003, own ACP session)
 │   │   │   ├─ Checks: input handling, error paths, abandonment, test gaps, conventions, assumptions
 │   │   │   ├─ Default diffMode: "ref" (no 50KB cap)
 │   │   │   └─ Parallel/sequential execution (configurable)
 │   │   │
 │   │   └─ Findings flow into the fix cycle as canonical Finding[]
 │   │
 │   │   On findings → runFixCycle (src/findings/cycle.ts, ADR-021/022)
 │   │   ├─ Mechanical lint fix strategy (lint --fix, format)
 │   │   └─ Agent fix strategies routed by Finding.fixTarget → re-validate
 │   │       ├─ stateless: full re-run
 │   │       └─ debate: full re-debate
 │   │
 │   └─ 4. COMPLETION (per story)
 │       completionStage.execute()
 │       └─ Persist SemanticVerdict to disk
 │
 └─ 5. ACCEPTANCE LOOP (post-run, after ALL stories complete)
     runAcceptanceLoop() — outer loop owns all retries
     ├─ Run acceptance tests (per-package)
     ├─ PASS → success (+ hardening pass for suggestedCriteria)
     ├─ Stub guard (stubRegenCount capped at 2) → full regen → continue
     ├─ resolveAcceptanceDiagnosis() (fresh each iteration, fast paths skip LLM)
     ├─ applyFix(diagnosis) — single attempt, no inner retry
     │   ├─ source_bug → acceptanceFixSourceOp
     │   ├─ test_bug   → acceptanceFixTestOp (surgical, in-place)
     │   └─ both       → acceptanceFixSourceOp + acceptanceFixTestOp
     ├─ previousFailure += attempt context
     └─ continue (always — back to acceptance test)
```

---

## Subsystem Details

### 1. Acceptance Test Generation

**Stage:** `acceptanceSetupStage` (pre-run pipeline)

**Files:**
- `src/pipeline/stages/acceptance-setup.ts` — pipeline stage entry
- `src/acceptance/generator.ts` — test code generation
- `src/acceptance/refinement.ts` — AC refinement (raw → testable)
- `src/acceptance/templates/` — strategy-specific templates
- `src/acceptance/test-path.ts` — path resolution

**Flow:**
1. Compute SHA-256 fingerprint of all sorted AC strings across non-fix stories
2. Compare against `acceptance-meta.json` — skip if unchanged
3. Group stories by `story.workdir` (monorepo-aware)
4. Optional: LLM refines raw ACs into concrete, machine-verifiable assertions
5. Generate one test file per workdir group: `<package-root>/.nax-acceptance.test.ts`
6. RED gate: run tests expecting FAIL — if all pass, tests aren't testing new behavior

**Output stored:** `ctx.acceptanceTestPaths: Array<{ testPath, packageDir }>`

---

### 2. Semantic Review

**Where it runs:** the `semantic-review` and `adversarial-review` phases of the story orchestrator's `CANONICAL_ORDER` (`src/execution/story-orchestrator.ts`), per story.

**Files:**
- `src/operations/semantic-review.ts` — semantic review operation
- `src/operations/adversarial-review.ts` — adversarial review operation (REVIEW-003)
- `src/review/semantic.ts` — LLM-based semantic check
- `src/review/adversarial.ts` — LLM-based adversarial review (REVIEW-003)
- `src/review/diff-utils.ts` — shared diff utilities (collectDiff, truncateDiff, resolveEffectiveRef)
- `src/review/semantic-debate.ts` — debate-path semantic review (`runSemanticDebate`)
- `src/review/runner.ts` — check orchestration (lint, typecheck, semantic, adversarial)

**Two review paths** (selected by `debate.enabled` + `debate.stages.review.enabled`). The dialogue / `ReviewerSession` path was removed (`review.dialogue` is a rejected legacy config key):

| debate | Path | Reviewer | Resolver |
|:---:|:---|:---|:---|
| off | stateless (default) | `agent.run()` or `agent.complete()` | N/A |
| on | debate | N debaters (panel one-shot) | resolver-derived base selector + `review-grounding-filter` post-debate verifier |

**Re-review behavior:** Both paths re-run from scratch on the next fix-cycle iteration — there is no persistent reviewer session to carry delta context.

---

### 3. Semantic Verdict Persistence

**Files:**
- `src/acceptance/semantic-verdict.ts` — read/write helpers (`persistSemanticVerdict`)
- `src/pipeline/stages/completion.ts` — `persistSemanticVerdict` is wired into `_completionDeps`

**Write (per-story):** The execution stage writes the verdict directly when the `semantic-review` phase produces one (`reviewResult` was removed in US-005c):
```
SemanticVerdict { storyId, passed, timestamp, acCount, findings[] }
  → <featureDir>/semantic-verdicts/<storyId>.json
```

**Read (in acceptance loop):**
```
loadSemanticVerdicts(featureDir) → all verdict files
  → used by resolveAcceptanceDiagnosis() fast-path (skips LLM diagnosis)
```

**Lifecycle:** Semantic verdicts persist on disk and survive across the acceptance loop, which runs post-completion.

---

### 4. Acceptance Loop (Diagnose & Fix)

Restructured per [ADR-006](../adr/ADR-006-acceptance-retry-restructure.md). The outer loop owns all retry logic; inner functions apply exactly one fix per iteration.

**Files:**
- `src/execution/lifecycle/acceptance-loop.ts` — outer retry loop (`runAcceptanceLoop`)
- `src/execution/lifecycle/acceptance-fix.ts` — `applyFix()` + `resolveAcceptanceDiagnosis()`
- `src/execution/lifecycle/acceptance-helpers.ts` — `isStubTestFile`, `isTestLevelFailure`, `regenerateAcceptanceTest`
- `src/operations/acceptance-diagnose.ts` — acceptance diagnosis operation
- `src/operations/acceptance-fix.ts` — acceptance fix operations (source + test)

**Loop structure:**
```
let stubRegenCount = 0
let previousFailure = ""

while (retries < maxRetries):
  1. Run acceptance tests via acceptanceStage
     ├─ PASS → return success (+ hardening pass)
     └─ FAIL → collect { failedACs, testOutput }

  2. retries++
     └─ >= maxRetries? → on-pause hook + return failure

  3. STUB GUARD
     ├─ Test file is a stub?
     │   ├─ stubRegenCount >= 2 → return failure ("generator cannot produce tests")
     │   └─ stubRegenCount++ → regenerateAcceptanceTest() → continue
     └─ Otherwise → step 4

  4. resolveAcceptanceDiagnosis() — FRESH EACH ITERATION
     ├─ Fast path: implement-only strategy → source_bug (skip LLM)
     ├─ Fast path: all semantic verdicts passed → test_bug (skip LLM)
     ├─ Fast path: >80% ACs fail OR AC-ERROR sentinel → test_bug (skip LLM)
     └─ Slow path: acceptanceDiagnoseOp via callOp

  5. applyFix(diagnosis, previousFailure) — SINGLE ATTEMPT
     ├─ source_bug → acceptanceFixSourceOp (one call)
     ├─ test_bug   → acceptanceFixTestOp (one call, surgical)
     └─ both       → acceptanceFixSourceOp + acceptanceFixTestOp

  6. previousFailure += "Attempt N: verdict=X, reasoning=Y, failedACs=Z"

  7. continue (always — back to step 1)
```

**Key properties:**

- **Outer loop always continues** after `applyFix()` — never exits early on fix failure
- **Fresh diagnosis each iteration** — verdict can change as fixes are applied (e.g. `test_bug` → `source_bug` after a regen)
- **No inline acceptance re-test** in `applyFix` — the outer loop handles all re-testing
- **No inner retry loops** — `applyFix` does exactly one fix attempt per verdict
- **`previousFailure` accumulates** across iterations and is passed to diagnosis, source fix, and test fix
- **Single retry budget**: `acceptance.maxRetries` (default 3). `acceptance.fix.maxRetries` is deprecated.

**Diagnosis fast paths** (in `resolveAcceptanceDiagnosis`):

| Condition | Verdict | Confidence | Cost |
|:----------|:--------|:-----------|:-----|
| `strategy: "implement-only"` | `source_bug` | 1.0 | 0 (no LLM) |
| All semantic verdicts passed | `test_bug` | 1.0 | 0 (no LLM) |
| `"AC-ERROR"` sentinel OR >80% ACs failed | `test_bug` | 0.9 | 0 (no LLM) |
| Otherwise | `acceptanceDiagnoseOp` | parsed | LLM cost |

**Fix routing (in `applyFix`):**

| Diagnosis verdict | Action |
|:------------------|:-------|
| `source_bug` | `acceptanceFixSourceOp` — `sessionRole: "source-fix"`, modifies source code only |
| `test_bug` | `acceptanceFixTestOp` — `sessionRole: "test-fix"`, **surgical patch** of failing assertions, preserves passing tests |
| `both` | `acceptanceFixSourceOp` then `acceptanceFixTestOp` in sequence |

**Stub guard:** When the test file matches `isStubTestFile()` (skeleton with `expect(true).toBe(...)`), the loop calls `regenerateAcceptanceTest()` (full regen). The `stubRegenCount` counter caps this at 2 attempts to prevent infinite loops if the generator can't produce real tests.

**Why no full regen for `test_bug`?** Surgical `acceptanceFixTestOp` preserves passing tests. Full regen throws away the entire file and often reproduces the same bugs. The fresh diagnosis each iteration handles strategy escalation — if surgical fix keeps failing, the verdict may change to `source_bug` and the loop tries that instead. See [ADR-006](../adr/ADR-006-acceptance-retry-restructure.md) for the full rationale.

---

## Integration Points

| From | To | Mechanism | Data |
|:-----|:---|:----------|:-----|
| Acceptance setup | Acceptance stage | `ctx.acceptanceTestPaths[]` | Per-package test file paths |
| Semantic review | Completion stage | `ctx.reviewResult.checks[semantic]` | Findings, pass/fail |
| Execution stage | Acceptance loop | `persistSemanticVerdict()` → disk | SemanticVerdict JSON |
| Acceptance loop | Diagnosis fast path | `loadSemanticVerdicts()` ← disk | All-passed → skip LLM diagnosis |
| Review phases | Fix cycle | Canonical `Finding[]` (with `fixTarget`) | Findings, check output |
| Fix cycle | Re-review | `runFixCycle` re-validates (full re-run) | Canonical `Finding[]` |
| `runAcceptanceLoop` | `resolveAcceptanceDiagnosis` | `previousFailure` accumulator | Diagnosis reasoning + test output from prior attempts |
| `resolveAcceptanceDiagnosis` | `applyFix` | `DiagnosisResult` | verdict, reasoning, confidence |
| `applyFix` | `acceptanceFixSourceOp` / `acceptanceFixTestOp` | `previousFailure` | Accumulated context across retries |

---

## Debate Review Flow

When `debate.enabled && debate.stages.review.enabled` is true, semantic review runs as a debate panel (`runSemanticDebate` in `src/review/semantic-debate.ts`):

```
semantic.ts (reviewDebateEnabled = true)
  │
  ├─ Build prompt from story ACs + production diff
  ├─ Compose review DebateStageConfig (always):
  │     sessionMode: "one-shot", mode: "panel",
  │     selector: resolver-derived base selector (pickBaseSelectorKind),
  │     postDebateVerifier: { kind: "review-grounding-filter" }
  │
  ├─ debateRunner.run(prompt)
  │   ├─ N debaters produce proposals (stateless, one-shot panel)
  │   └─ post-debate verifier grounds claims against the actual diff
  │
  ├─ resolverPassed = debateResult.outcome === "passed"
  └─ Re-derive verdict: parse proposals, dedupe findings by AC id / file:line
        → ReviewCheckResult
```

There is no persistent reviewer session and no `resolveDebate()`/dialogue continuation — that path was removed (2026-05-29 ReviewerSession removal). The resolver type is read from `debate.stages.review.resolverType`.

---

## Failure Handling Summary

| Failure | Recovery |
|:--------|:---------|
| Debater proposal fails | Excluded; debate continues with remaining debaters |
| All debaters fail | `DebateResult.outcome = "failed"` — story escalates |
| Semantic parse fails | Fail-open (pass with warning) |
| Semantic parse fails with `"passed": false` | Fail-closed (LLM intended failure) |
| Acceptance test crashes | `AC-ERROR` sentinel → diagnosis fast path → `test_bug` → `acceptanceFixTestOp` |
| Source fix fails | Outer loop continues; next iteration's fresh diagnosis may change verdict |
| Test file is a stub | Stub guard → `regenerateAcceptanceTest()` (full regen, capped at 2 attempts) |
| Max acceptance retries exceeded | Return failure, fire `on-pause` hook |

---

## Design Decisions

1. **Semantic review is stateless per story.** Each review phase (and each fix-cycle re-review) runs from scratch — there is no persistent reviewer session carried across the acceptance loop, which runs post-completion. Semantic verdicts on disk bridge this gap.

2. **Verdicts on disk are the cross-phase contract.** Because review leaves no live session behind, the only state the acceptance loop reads is the persisted `SemanticVerdict` files.

---

## Design Tradeoffs

Intentional gaps accepted during initial implementation. Revisit if acceptance fix accuracy degrades.

### GAP-2: Acceptance loop does not re-run semantic review after fix

After `acceptanceFixSourceOp` succeeds, the acceptance loop re-runs acceptance tests only — it does NOT re-run semantic review. Semantic verdict files on disk remain stale (from pre-fix).

**Why accepted:** Source fixes are scoped to failing ACs. Re-running semantic review would add LLM cost with marginal benefit since the acceptance tests themselves validate the fix.

**When to revisit:** If source fixes introduce new semantic issues that acceptance tests don't catch. The fix would be to re-run the `semantic-review` phase (`semanticReviewOp`) after a successful source fix before looping back.

### GAP-4: Acceptance diagnosis does not receive debate proposals

`acceptanceDiagnoseOp` receives test output, source files, semantic verdict context, and `previousFailure` accumulator — but NOT the debate proposals or resolver findings. When debate produced the semantic verdict, the diagnosis agent doesn't see the panel's reasoning about why it passed/failed.

**Why accepted:** The diagnosis agent focuses on test vs source bug classification, not semantic reasoning. The `resolveAcceptanceDiagnosis()` fast path skips the LLM call entirely when all semantic verdicts passed — so debate findings are only relevant in the slow-path mixed-verdict case.

**When to revisit:** If diagnosis accuracy is poor when debate is enabled with mixed verdicts. The fix would be to thread the debate findings into the diagnosis prompt, which requires persisting them alongside semantic verdicts.

### GAP-5: `previousFailure` is not persisted across runs

The `previousFailure` accumulator lives in memory inside `runAcceptanceLoop()`. When the run terminates (success, failure, or interruption), the context is lost. A subsequent run starts with empty `previousFailure`.

**Why accepted:** Within a single run, retries are bounded by `maxRetries: 3`. Persisting `previousFailure` would only matter for cross-run resumption, which is a separate feature.

**When to revisit:** If we add explicit cross-run resumption (`nax resume`) that needs to remember why the previous run failed.
