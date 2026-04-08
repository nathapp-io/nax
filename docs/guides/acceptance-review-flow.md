---
title: Acceptance & Review End-to-End Flow
description: How acceptance testing, semantic review, debate+dialogue, and diagnose/fix connect
---

## Acceptance & Review End-to-End Flow

This document maps how four subsystems connect across the nax pipeline:

1. **Acceptance test generation** — creates tests from acceptance criteria
2. **Semantic review** — LLM-verified behavioral check against ACs
3. **Acceptance loop** — post-run gate with diagnose/fix retry
4. **Debate + dialogue** — multi-agent resolution with tool access

---

## Pipeline Execution Order

```
PRD loaded (stories with acceptance criteria)
 │
 ├─ 1. ACCEPTANCE SETUP (pre-run pipeline)
 │   acceptanceSetupStage → generateFromPRD()
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
 │   ├─ 3. SEMANTIC REVIEW (review pipeline stage)
 │   │   reviewStage.execute()
 │   │   ├─ PATH A: dialogue only → ReviewerSession.review()
 │   │   ├─ PATH B: debate only → DebateSession + stateless resolver
 │   │   ├─ PATH C: debate + dialogue → DebateSession + resolveDebate()
 │   │   └─ PATH D: stateless → agent.run() or agent.complete()
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
     runAcceptanceLoop() — retry up to maxRetries
     ├─ Run acceptance tests (per-package)
     ├─ If ALL pass → success
     ├─ Failure triage → diagnose → fix → retry
     └─ Legacy path (no strategy): generate US-FIX-* stories → retry
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
- `src/review/dialogue.ts` — ReviewerSession (persistent, tool-capable)
- `src/review/dialogue-prompts.ts` — prompt builders for dialogue/debate
- `src/review/runner.ts` — check orchestration (lint, typecheck, semantic)
- `src/review/orchestrator.ts` — plugin reviewer coordination

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
  → used by isTestLevelFailure() and runFixRouting() fast-path
```

**Lifecycle:** ReviewerSession is destroyed in completion stage. Semantic verdicts persist on disk and survive across the acceptance loop.

---

### 4. Acceptance Loop (Diagnose & Fix)

**Files:**
- `src/execution/lifecycle/acceptance-loop.ts` — main retry loop
- `src/acceptance/fix-diagnosis.ts` — LLM diagnosis (test bug vs source bug)
- `src/acceptance/fix-generator.ts` — fix story generation
- `src/acceptance/fix-executor.ts` — source fix execution

**Loop structure:**
```
while (retries < maxRetries):
  1. Run acceptance tests via acceptanceStage
  2. If pass → return success
  3. Parse failedACs[]

  4. TRIAGE (checked in order)
     ├─ Stub detection (skeleton test) → regenerate test → loop back
     ├─ isTestLevelFailure() → regenerate test → loop back
     ├─ Strategy is "diagnose-first" or "implement-only":
     │   └─ runFixRouting() → diagnose → source fix or test regen
     │       ├─ fixed=true → loop back to step 1
     │       └─ fixed=false → return failure (no fix story fallback)
     └─ Legacy path (no strategy configured):
         └─ generateAndAddFixStories() → US-FIX-* stories
             → execute through pipeline → loop back to step 1
```

**isTestLevelFailure() decision tree:**

| Condition | Result |
|:----------|:-------|
| All semantic verdicts passed | TEST BUG (fast-path, skip diagnosis) |
| `"AC-ERROR"` in failedACs | TEST BUG (test crashed) |
| >80% of total ACs failed | TEST BUG (threshold) |
| Otherwise | SOURCE BUG |

**Fix routing (diagnose-first strategy):**

| Diagnosis verdict | Action |
|:------------------|:-------|
| `source_bug` | `executeSourceFix()` — agent session with `sessionRole: "source-fix"` |
| `test_bug` | `regenerateAcceptanceTest()` — backup, delete, re-run acceptance-setup |
| `both` | Source fix first, then regen if still failing |

**Fix story generation** (when source fix fails):
- `groupACsByRelatedStories()` — batch failed ACs by shared implementation
- `convertFixStoryToUserStory()` — creates US-FIX-* with inherited workdir (D4)
- Fix stories execute through the normal pipeline (implement → review → test)

---

## Integration Points

| From | To | Mechanism | Data |
|:-----|:---|:----------|:-----|
| Acceptance setup | Acceptance stage | `ctx.acceptanceTestPaths[]` | Per-package test file paths |
| Semantic review | Completion stage | `ctx.reviewResult.checks[semantic]` | Findings, pass/fail |
| Completion stage | Acceptance loop | `persistSemanticVerdict()` → disk | SemanticVerdict JSON |
| Acceptance loop | Semantic verdicts | `loadSemanticVerdicts()` ← disk | Fast-path for test-level failure |
| Review stage | Autofix stage | `ctx.reviewResult` (success=false) | Findings, check output |
| Autofix | Review stage | Pipeline retry (`fromStage: "review"`) | `ctx.reviewerSession` persists |
| Debate resolver | ReviewerSession | `resolverContextInput` | diff, story, semanticConfig, resolverType |
| Fix diagnosis | Source fix | `DiagnosisResult` | verdict, reasoning, confidence |
| Fix stories | Pipeline | `convertFixStoryToUserStory()` | US-FIX-* with inherited workdir |

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
| Acceptance test crashes | `AC-ERROR` sentinel → test-level failure → regenerate |
| Source fix fails | Generate US-FIX-* stories → execute through pipeline |
| Max acceptance retries exceeded | Return failure, fire `on-pause` hook |

---

## Design Decisions

1. **ReviewerSession is per-story, not per-run.** Created in review stage, destroyed in completion stage. The acceptance loop runs post-completion, so it cannot reuse the session. Semantic verdicts on disk bridge this gap.

2. **Plan stage does not use dialogue.** `ReviewerSession` is review-stage only. Plan stage generates PRD specs — no diff, no acceptance criteria, no implementer to clarify with.

---

## Design Tradeoffs

Intentional gaps accepted during initial implementation. Revisit if acceptance fix accuracy degrades.

### GAP-2: Acceptance loop does not re-run semantic review after fix

After `executeSourceFix()` succeeds, the acceptance loop re-runs acceptance tests only — it does NOT re-run semantic review. Semantic verdict files on disk remain stale (from pre-fix).

**Why accepted:** Source fixes are scoped to failing ACs. Re-running semantic review would add LLM cost with marginal benefit since the acceptance tests themselves validate the fix.

**When to revisit:** If source fixes introduce new semantic issues that acceptance tests don't catch. The fix would be to re-run `reviewStage` (or at least `runSemanticReview`) after a successful source fix before looping back.

### GAP-4: Acceptance diagnosis does not receive debate proposals

`diagnoseAcceptanceFailure()` receives test output and source files but NOT the debate proposals or resolver findings. When debate+dialogue produced the semantic verdict, the diagnosis agent doesn't see the reviewer's reasoning about why it passed/failed.

**Why accepted:** The diagnosis agent focuses on test vs source bug classification, not semantic reasoning. The semantic verdict `passed: true/false` is sufficient context via the `isTestLevelFailure()` fast-path — when all verdicts passed, diagnosis is skipped entirely.

**When to revisit:** If diagnosis accuracy is poor when debate+dialogue is enabled. The fix would be to thread `dialogueResult.findingReasoning` into the diagnosis prompt, which requires persisting debate findings alongside semantic verdicts.
