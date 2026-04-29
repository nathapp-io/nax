---
title: Acceptance & Review End-to-End Flow
description: How acceptance testing, semantic review, debate+dialogue, and diagnose/fix connect
---

## Acceptance & Review End-to-End Flow

This document maps how four subsystems connect across the nax pipeline:

1. **Acceptance test generation** — creates tests from acceptance criteria
2. **Semantic review** — LLM-verified behavioral check against ACs
3. **Adversarial review** — LLM-based adversarial code review (REVIEW-003)
4. **Acceptance loop** — post-run gate with diagnose/fix retry
5. **Debate + dialogue** — multi-agent resolution with tool access

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
 │   ├─ 3. REVIEW (review pipeline stage)
 │   │   reviewStage.execute() → orchestrator.ts
 │   │   ├─ SEMANTIC REVIEW (behavioral AC check)
 │   │   │   ├─ PATH A: dialogue only → ReviewerSession.review()
 │   │   │   ├─ PATH B: debate only → DebateSession + stateless resolver
 │   │   │   ├─ PATH C: debate + dialogue → DebateSession + resolveDebate()
 │   │   │   └─ PATH D: stateless → agent.run() or agent.complete()
 │   │   │
 │   │   ├─ ADVERSARIAL REVIEW (REVIEW-003, own ACP session)
 │   │   │   ├─ Checks: input handling, error paths, abandonment, test gaps, conventions, assumptions
 │   │   │   ├─ Default diffMode: "ref" (no 50KB cap)
 │   │   │   └─ Parallel/sequential execution (configurable)
 │   │   │
 │   │   └─ Orchestrator coordinates semantic + adversarial execution
 │   │
 │   │   On failure → autofix stage
 │   │   ├─ Mechanical fix (lint --fix, format)
 │   │   └─ Agent rectification → retry review
 │   │       ├─ dialogue: reReview() (session continuity)
 │   │       ├─ debate+dialogue: reReviewDebate() (session continuity)
 │   │       └─ stateless: full re-run
 │   │
 │   └─ 4. COMPLETION (per story)
 │       completionStage.execute()
 │       ├─ Persist SemanticVerdict to disk
 │       └─ Destroy ReviewerSession
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

**Stage:** `reviewStage` (default pipeline, per story)

**Files:**
- `src/pipeline/stages/review.ts` — pipeline stage entry
- `src/review/semantic.ts` — LLM-based semantic check
- `src/review/adversarial.ts` — LLM-based adversarial review (REVIEW-003)
- `src/review/diff-utils.ts` — shared diff utilities (collectDiff, truncateDiff, resolveEffectiveRef)
- `src/review/dialogue.ts` — ReviewerSession (persistent, tool-capable)
- `src/review/runner.ts` — check orchestration (lint, typecheck, semantic, adversarial)
- `src/review/orchestrator.ts` — review coordination (semantic + adversarial + plugin)

**Four review paths** (selected by `debate.enabled`, `dialogue.enabled`):

| debate | dialogue | Path | Reviewer | Resolver |
|:---:|:---:|:---|:---|:---|
| off | off | D: stateless | `agent.run()` or `agent.complete()` | N/A |
| off | on | A: dialogue | `ReviewerSession.review()` | N/A |
| on | off | B: debate | N debaters via `agent.complete()` | Stateless (majority/synthesis/custom) |
| on | on | C: debate+dialogue | N debaters via `agent.complete()` | `reviewerSession.resolveDebate()` |

**Autofix retry behavior:**

| Path | Retry mechanism | Session continuity |
|:-----|:----------------|:-------------------|
| A: dialogue | `ReviewerSession.reReview(newDiff)` | Yes — delta from previous findings |
| B: debate | Full re-debate | No |
| C: debate+dialogue | `reviewerSession.reReviewDebate()` | Yes — delta from previous debate |
| D: stateless | Full re-run | No |

---

### 3. Semantic Verdict Persistence

**Files:**
- `src/pipeline/stages/completion.ts` (lines 98–109) — writes verdict after story completes
- `src/acceptance/semantic-verdict.ts` — read/write helpers

**Write (per-story, in completion stage):**
```
ctx.reviewResult.checks[check === "semantic"]
  → SemanticVerdict { storyId, passed, timestamp, acCount, findings[] }
  → <featureDir>/semantic-verdicts/<storyId>.json
```

**Read (in acceptance loop):**
```
loadSemanticVerdicts(featureDir) → all verdict files
  → used by resolveAcceptanceDiagnosis() fast-path (skips LLM diagnosis)
```

**Lifecycle:** ReviewerSession is destroyed in completion stage. Semantic verdicts persist on disk and survive across the acceptance loop.

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
| Completion stage | Acceptance loop | `persistSemanticVerdict()` → disk | SemanticVerdict JSON |
| Acceptance loop | Diagnosis fast path | `loadSemanticVerdicts()` ← disk | All-passed → skip LLM diagnosis |
| Review stage | Autofix stage | `ctx.reviewResult` (success=false) | Findings, check output |
| Autofix | Review stage | Pipeline retry (`fromStage: "review"`) | `ctx.reviewerSession` persists |
| Debate resolver | ReviewerSession | `resolverContextInput` | diff, story, semanticConfig, resolverType |
| `runAcceptanceLoop` | `resolveAcceptanceDiagnosis` | `previousFailure` accumulator | Diagnosis reasoning + test output from prior attempts |
| `resolveAcceptanceDiagnosis` | `applyFix` | `DiagnosisResult` | verdict, reasoning, confidence |
| `applyFix` | `acceptanceFixSourceOp` / `acceptanceFixTestOp` | `previousFailure` | Accumulated context across retries |

---

## Debate + Dialogue Resolver Flow (Path C)

When both `debate.stages.review.enabled` and `review.dialogue.enabled` are true:

```
semantic.ts (reviewDebateEnabled = true)
  │
  ├─ Build prompt from story ACs + production diff
  ├─ Create DebateSession with reviewerSession + resolverContextInput
  │   resolverContextInput = { diff, story, semanticConfig, resolverType, isReReview }
  │
  ├─ debateSession.run(prompt)
  │   ├─ N debaters produce proposals (stateless, parallel)
  │   ├─ Optional critique/rebuttal round
  │   └─ resolveOutcome()
  │       ├─ Build DebateResolverContext { resolverType, majorityVote? }
  │       ├─ If isReReview: reviewerSession.reReviewDebate()
  │       └─ Else: reviewerSession.resolveDebate()
  │           ├─ Agent.run() with tool access (READ, GREP)
  │           ├─ Verifies debater claims against actual code
  │           ├─ Adds messages to session history
  │           └─ Returns ReviewDialogueResult
  │
  ├─ Detect session usage: history.length > historyLenBefore
  └─ If used: reviewerSession.getVerdict() → ReviewCheckResult
```

**Fallback chain:**
1. `resolveDebate()` throws → stateless resolver (majority/synthesis/custom)
2. Stateless resolver produces result
3. `ReviewerSession` remains alive for CLARIFY channel during autofix

---

## Failure Handling Summary

| Failure | Recovery |
|:--------|:---------|
| Debater proposal fails | Excluded; debate continues with remaining debaters |
| All debaters fail | `DebateResult.outcome = "failed"` — story escalates |
| `resolveDebate()` throws | Falls back to stateless resolver |
| `reReviewDebate()` throws | Falls back to full re-debate |
| ReviewerSession destroyed | `REVIEWER_SESSION_DESTROYED` error — caught by fallback |
| Semantic parse fails | Fail-open (pass with warning) |
| Semantic parse fails with `"passed": false` | Fail-closed (LLM intended failure) |
| Acceptance test crashes | `AC-ERROR` sentinel → diagnosis fast path → `test_bug` → `acceptanceFixTestOp` |
| Source fix fails | Outer loop continues; next iteration's fresh diagnosis may change verdict |
| Test file is a stub | Stub guard → `regenerateAcceptanceTest()` (full regen, capped at 2 attempts) |
| Max acceptance retries exceeded | Return failure, fire `on-pause` hook |

---

## Design Decisions

1. **ReviewerSession is per-story, not per-run.** Created in review stage, destroyed in completion stage. The acceptance loop runs post-completion, so it cannot reuse the session. Semantic verdicts on disk bridge this gap.

2. **Plan stage does not use dialogue.** `ReviewerSession` is review-stage only. Plan stage generates PRD specs — no diff, no acceptance criteria, no implementer to clarify with.

---

## Design Tradeoffs

Intentional gaps accepted during initial implementation. Revisit if acceptance fix accuracy degrades.

### GAP-2: Acceptance loop does not re-run semantic review after fix

After `acceptanceFixSourceOp` succeeds, the acceptance loop re-runs acceptance tests only — it does NOT re-run semantic review. Semantic verdict files on disk remain stale (from pre-fix).

**Why accepted:** Source fixes are scoped to failing ACs. Re-running semantic review would add LLM cost with marginal benefit since the acceptance tests themselves validate the fix.

**When to revisit:** If source fixes introduce new semantic issues that acceptance tests don't catch. The fix would be to re-run `reviewStage` (or at least `runSemanticReview`) after a successful source fix before looping back.

### GAP-4: Acceptance diagnosis does not receive debate proposals

`acceptanceDiagnoseOp` receives test output, source files, semantic verdict context, and `previousFailure` accumulator — but NOT the debate proposals or resolver findings. When debate+dialogue produced the semantic verdict, the diagnosis agent doesn't see the reviewer's reasoning about why it passed/failed.

**Why accepted:** The diagnosis agent focuses on test vs source bug classification, not semantic reasoning. The `resolveAcceptanceDiagnosis()` fast path skips the LLM call entirely when all semantic verdicts passed — so debate findings are only relevant in the slow-path mixed-verdict case.

**When to revisit:** If diagnosis accuracy is poor when debate+dialogue is enabled with mixed verdicts. The fix would be to thread `dialogueResult.findingReasoning` into the diagnosis prompt, which requires persisting debate findings alongside semantic verdicts.

### GAP-5: `previousFailure` is not persisted across runs

The `previousFailure` accumulator lives in memory inside `runAcceptanceLoop()`. When the run terminates (success, failure, or interruption), the context is lost. A subsequent run starts with empty `previousFailure`.

**Why accepted:** Within a single run, retries are bounded by `maxRetries: 3`. Persisting `previousFailure` would only matter for cross-run resumption, which is a separate feature.

**When to revisit:** If we add explicit cross-run resumption (`nax resume`) that needs to remember why the previous run failed.
