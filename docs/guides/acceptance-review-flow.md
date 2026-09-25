---
title: Acceptance & Review End-to-End Flow
description: How acceptance testing, semantic review, and diagnose/fix connect
---

## Acceptance & Review End-to-End Flow

This document maps how four subsystems connect across the nax pipeline:

1. **Acceptance test generation** — creates tests from acceptance criteria
2. **Semantic review** — LLM-verified behavioral check against ACs
3. **Adversarial review** — LLM-based adversarial code review (REVIEW-003)
4. **Acceptance loop** — post-run gate with diagnose/fix retry

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
 │   │   │   └─ stateless → agent.run() or agent.complete()
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
 │   │
 │   └─ 4. COMPLETION (per story)
 │       completionStage.execute()
 │
 └─ 5. ACCEPTANCE LOOP (post-run, after ALL stories complete)
     runAcceptanceLoop()
     ├─ Run acceptance tests (per-package)
     ├─ PASS → success (+ hardening pass for suggestedCriteria)
     ├─ Stub guard (stubRegenCount capped at 2) → full regen → continue
     ├─ Per failed package (#1277):
     │   ├─ resolveAcceptanceDiagnosis() (fast paths skip LLM)
     │   └─ runAcceptanceFixCycle() → runFixCycle (ADR-022)
     │       ├─ acceptance-source-fix → acceptanceFixSourceOp   (source_bug / both)
     │       ├─ acceptance-test-fix   → acceptanceFixTestOp     (test_bug / both, surgical)
     │       └─ validate = re-run that package's acceptance tests
     └─ Final full validation pass (all packages) → success / failure
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
5. Generate one test file per workdir group under that package's feature dir: `<packageDir>/.nax/features/<feature>/<acceptance.testPath>` (default filename by language: `.nax-acceptance.test.ts`, `.nax-acceptance_test.go`, `_nax_acceptance_test.py`, `.nax-acceptance.rs`)
6. RED gate (`acceptance.redGate`, default `true`): run tests expecting FAIL — if all pass, tests aren't testing new behavior

Regeneration clears any stale `<featureDir>/semantic-verdicts/` files.

**Output stored:** `ctx.acceptanceTestPaths: Array<{ testPath, packageDir }>`

---

### 2. Semantic Review

**Where it runs:** the `semantic-review` and `adversarial-review` phases of the story orchestrator's `CANONICAL_ORDER` (`src/execution/story-orchestrator/types.ts`), per story, after `lint-check` / `typecheck-check`.

**Files:**
- `src/operations/semantic-review.ts` — semantic review operation
- `src/operations/adversarial-review.ts` — adversarial review operation (REVIEW-003)
- `src/review/diff-utils.ts` — shared diff utilities (collectDiff, truncateDiff, resolveEffectiveRef)
- `src/review/runner/` — check orchestration (lint, typecheck, semantic, adversarial)

Semantic review runs as a single stateless LLM pass (`semanticReviewOp`). The dialogue / `ReviewerSession` path was removed (2026-05-29), and the debate panel path was removed with the debate subsystem (2026-09-20) — `review.dialogue.enabled` is a rejected legacy config key.

**Re-review behavior:** The review re-runs from scratch on the next fix-cycle iteration — there is no persistent reviewer session to carry delta context.

---

### 3. Semantic Verdict Persistence

**Files:**
- `src/acceptance/semantic-verdict.ts` — read/write helpers (`persistSemanticVerdict`)
- `src/pipeline/stages/completion.ts` — `persistSemanticVerdict` is exposed on `_completionDeps`

**Write (per-story):** `persistSemanticVerdict()` writes
```
SemanticVerdict { storyId, passed, timestamp, acCount, findings[] }
  → <featureDir>/semantic-verdicts/<storyId>.json
```

> **Current state (v0.82.1):** no pipeline call site invokes `persistSemanticVerdict` — it is only exposed on `_completionDeps` (`reviewResult` was removed in US-005c and the write was not re-homed). In practice no verdict files are written during a run, so the "all semantic verdicts passed" diagnosis fast path below does not fire and the loop falls through to the other paths.

**Read (in acceptance loop):**
```
loadSemanticVerdicts(featureDir) → all verdict files
  → used by resolveAcceptanceDiagnosis() fast-path (skips LLM diagnosis)
```

**Lifecycle:** Semantic verdicts persist on disk and survive across the acceptance loop, which runs post-completion.

---

### 4. Acceptance Loop (Diagnose & Fix)

Restructured per [ADR-006](../adr/ADR-006-acceptance-retry-restructure.md), then moved onto the shared fix cycle (`runFixCycle`, [ADR-022](../adr/ADR-022-fix-strategy-and-cycle.md)). The outer loop owns the stub guard and the per-package fan-out; `runFixCycle` owns the per-package fix retries.

**Files:**
- `src/execution/lifecycle/acceptance-loop.ts` — outer loop (`runAcceptanceLoop`) + `runAcceptanceFixCycle()`
- `src/execution/lifecycle/acceptance-fix.ts` — `resolveAcceptanceDiagnosis()`
- `src/execution/lifecycle/acceptance-fix-scope.ts` — per-cycle scope carrying the Bash ask resolver + command-safety shadow for the fix ops
- `src/execution/lifecycle/acceptance-helpers.ts` — `isStubTestFile`, `isTestLevelFailure`, `regenerateAcceptanceTest`
- `src/operations/acceptance-diagnose.ts` — acceptance diagnosis operation
- `src/operations/acceptance-fix.ts` — acceptance fix operations (source + test)

**Loop structure:**
```
let stubRegenCount = 0

do:
  1. Run acceptance tests via acceptanceStage
     ├─ PASS → return success (+ hardening pass)
     └─ FAIL → collect { failedACs, testOutput, failedPackages }
        (no specific failures detected → on-pause hook + return failure)

  2. retries++
     └─ > maxRetries? → on-pause hook + return failure

  3. STUB GUARD
     ├─ Test file is a stub?
     │   ├─ stubRegenCount >= 2 → return failure ("generator cannot produce real tests")
     │   └─ stubRegenCount++ → regenerateAcceptanceTest() → continue
     └─ Otherwise → step 4

  4. For each failed package:
     a. resolveAcceptanceDiagnosis()
        ├─ Fast path: implement-only strategy → source_bug (skip LLM)
        ├─ Fast path: all semantic verdicts passed → test_bug (skip LLM)
        ├─ Fast path: >80% ACs fail OR AC-ERROR sentinel → test_bug (skip LLM)
        └─ Slow path: acceptanceDiagnoseOp via callOp
     b. runAcceptanceFixCycle(diagnosis) → runFixCycle
        ├─ strategies selected by verdict (source_bug / test_bug / both), co-run-sequential,
        │  each capped at 3 attempts, cycle capped at acceptance.maxRetries
        ├─ validate: re-run this package's acceptance tests → remaining Finding[]
        └─ prior attempts reach the test-fix prompt via buildPriorIterationsBlock()

  5. Final full validation pass across all packages
     └─ return success only if it passes and no package left findings
```

**Key properties:**

- **Per-package budgets** — each failed package gets its own fix cycle, scoped to its `packageDir`, test path, and command
- **Re-testing lives in the cycle** — `runFixCycle`'s `validate` re-runs acceptance tests after each fix attempt
- **Final full pass** catches cross-package regressions one isolated cycle could miss
- **Prior-attempt context** comes from the fix cycle's iteration log (`buildPriorIterationsBlock`); the old `previousFailure` string accumulator was deleted (ADR-022 phase 8). Only the test-fix op receives it
- **Retry budget**: `acceptance.maxRetries` (default 3) bounds both the outer loop and each package's fix cycle. `acceptance.fix.maxRetries` (default 2) is still in the schema but not read by the loop

**Diagnosis fast paths** (in `resolveAcceptanceDiagnosis`):

| Condition | Verdict | Confidence | Cost |
|:----------|:--------|:-----------|:-----|
| `strategy: "implement-only"` | `source_bug` | 1.0 | 0 (no LLM) |
| All semantic verdicts passed | `test_bug` | 1.0 | 0 (no LLM) |
| `"AC-ERROR"` sentinel OR >80% ACs failed | `test_bug` | 0.9 | 0 (no LLM) |
| Otherwise | `acceptanceDiagnoseOp` | parsed | LLM cost |

**Fix routing (fix-cycle strategies):**

| Diagnosis verdict | Action |
|:------------------|:-------|
| `source_bug` | `acceptanceFixSourceOp` — `sessionRole: "source-fix"`, modifies source code only |
| `test_bug` | `acceptanceFixTestOp` — `sessionRole: "test-fix"`, **surgical patch** of failing assertions, preserves passing tests |
| `both` | Both strategies, run co-run-sequential |

A failed-AC list made up only of the `AC-ERROR` / `AC-HOOK` sentinels bypasses the semantic-verdict fast path — stale verdicts can't vouch for a crashed runner or timed-out hook. `acceptance.fix.strategy` defaults to `"diagnose-first"`; `acceptance.fix.diagnoseModel` / `fixModel` default to `fast` / `balanced`.

**Stub guard:** When the test file matches `isStubTestFile()` (skeleton with `expect(true).toBe(...)`), the loop calls `regenerateAcceptanceTest()` (full regen). The `stubRegenCount` counter caps this at 2 attempts to prevent infinite loops if the generator can't produce real tests.

**Why no full regen for `test_bug`?** Surgical `acceptanceFixTestOp` preserves passing tests. Full regen throws away the entire file and often reproduces the same bugs. See [ADR-006](../adr/ADR-006-acceptance-retry-restructure.md) for the full rationale.

---

## Integration Points

| From | To | Mechanism | Data |
|:-----|:---|:----------|:-----|
| Acceptance setup | Acceptance stage | `ctx.acceptanceTestPaths[]` | Per-package test file paths |
| `persistSemanticVerdict()` (currently uncalled) | Acceptance loop | disk | SemanticVerdict JSON |
| Acceptance loop | Diagnosis fast path | `loadSemanticVerdicts()` ← disk | All-passed → skip LLM diagnosis |
| Review phases | Fix cycle | Canonical `Finding[]` (with `fixTarget`) | Findings, check output |
| Fix cycle | Re-review | `runFixCycle` re-validates (full re-run) | Canonical `Finding[]` |
| `runAcceptanceLoop` | `resolveAcceptanceDiagnosis` | per-package failures | Sliced test output, failed ACs |
| `resolveAcceptanceDiagnosis` | `runAcceptanceFixCycle` | `DiagnosisResult` | verdict, reasoning, confidence |
| `runFixCycle` | `acceptanceFixSourceOp` / `acceptanceFixTestOp` | `buildInput(findings, priorIterations)` | Test output, diagnosis reasoning, prior-iterations block |

---

## Failure Handling Summary

| Failure | Recovery |
|:--------|:---------|
| Semantic parse fails (after `review.parseRetryMaxAttempts`) | Fail-open (pass, `failOpen: true`) |
| Semantic parse fails with `"passed": false` | Fail-closed (LLM intended failure) |
| Acceptance test crashes | `AC-ERROR` sentinel → diagnosis fast path → `test_bug` → `acceptanceFixTestOp` |
| Source fix fails | Fix cycle retries within its budget; unresolved findings fail the run after the final validation pass |
| Test file is a stub | Stub guard → `regenerateAcceptanceTest()` (full regen, capped at 2 attempts) |
| Max acceptance retries exceeded | Return failure, fire `on-pause` hook |

---

## Design Decisions

1. **Semantic review is stateless per story.** Each review phase (and each fix-cycle re-review) runs from scratch — there is no persistent reviewer session carried across the acceptance loop, which runs post-completion. Semantic verdicts on disk are meant to bridge this gap.

2. **Verdicts on disk are the cross-phase contract.** Because review leaves no live session behind, the only review state the acceptance loop reads is the persisted `SemanticVerdict` files (see the current-state note in §3).

---

## Design Tradeoffs

Intentional gaps accepted during initial implementation. Revisit if acceptance fix accuracy degrades.

### GAP-2: Acceptance loop does not re-run semantic review after fix

After `acceptanceFixSourceOp` succeeds, the acceptance loop re-runs acceptance tests only — it does NOT re-run semantic review. Semantic verdict files on disk remain stale (from pre-fix).

**Why accepted:** Source fixes are scoped to failing ACs. Re-running semantic review would add LLM cost with marginal benefit since the acceptance tests themselves validate the fix.

**When to revisit:** If source fixes introduce new semantic issues that acceptance tests don't catch. The fix would be to re-run the `semantic-review` phase (`semanticReviewOp`) after a successful source fix before looping back.

### GAP-5: Acceptance fix history is not persisted across runs

The prior-iterations context lives in the in-memory `FixCycle` inside `runAcceptanceFixCycle()`. When the run terminates (success, failure, or interruption), it is lost. A subsequent run starts with no prior-attempt context.

**Why accepted:** Within a single run, retries are bounded by `acceptance.maxRetries` (default 3). Persisting the history would only matter for cross-run resumption, which is a separate feature.

**When to revisit:** If we add explicit cross-run resumption (`nax resume`) that needs to remember why the previous run failed.
