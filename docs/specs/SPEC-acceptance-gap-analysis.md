# Acceptance Pipeline Gap Analysis

*Authored: 2026-04-05 by Nax Dev (Claude Opus 4)*

## Overview

Analysis of the full acceptance test lifecycle — from generation through fix — identifying gaps that cause acceptance tests to persistently fail even when the feature implementation is correct.

## End-to-End Flow

```
Pre-run:
  1. acceptance-setup    → refine ACs → LLM generates test file → RED gate

Per-story pipeline (stages 1-13):
  2. execution           → agent implements the feature
  3. verify              → unit tests pass
  4. review (stage 10)   → semantic review validates ACs against git diff
  5. autofix             → fixes semantic findings if any
  6. completion          → marks story "passed"
     iteration-runner    → ctx.reviewResult = undefined  (GC'd!)

Post-run:
  7. acceptance stage    → runs test file → pass/fail (no access to semantic results)
  8. acceptance-loop     → diagnose → fix/regen → re-run acceptance → repeat
```

## Key Source Files

| File | Role |
|:-----|:-----|
| `src/pipeline/stages/acceptance-setup.ts` | Generates acceptance tests pre-implementation |
| `src/acceptance/generator.ts` | LLM-based test code generation |
| `src/acceptance/refinement.ts` | Refines raw ACs into testable assertions |
| `src/review/semantic.ts` | LLM-based per-story AC verification against git diff |
| `src/pipeline/stages/review.ts` | Orchestrates semantic + lint + typecheck checks |
| `src/execution/iteration-runner.ts` | Per-story loop; GC's reviewResult at line 133 |
| `src/pipeline/stages/acceptance.ts` | Runs acceptance tests post-implementation |
| `src/execution/lifecycle/acceptance-loop.ts` | Retry loop: diagnose → fix → re-test |
| `src/acceptance/fix-diagnosis.ts` | Diagnoses whether failure is source or test bug |
| `src/acceptance/fix-executor.ts` | Executes source code fixes |
| `src/acceptance/fix-generator.ts` | Generates fix stories from failed ACs |

---

## Gap Analysis

### GAP 1: Test Generator Has No Access to Implementation Context

**Stage:** `acceptance-setup` → `generator.ts`  
**Severity:** High

**Problem:** The test generator runs BEFORE implementation. It gets ACs + codebase context but has to **guess** the API surface — function names, import paths, return types. When the implementing agent makes different design choices (different function names, different module structure), the acceptance tests import non-existent paths or call wrong APIs.

**Evidence:** The generator prompt says "explore the project" but at generation time, the feature code doesn't exist yet. The generated test assumes an API shape that the implementer may not follow.

**Impact:** Tests fail with import errors or `undefined is not a function` — not because the feature is wrong, but because the test assumed a different API.

---

### GAP 2: Implementer Never Sees the Acceptance Tests ⚠️ Critical

**Stage:** `execution` (story pipeline)  
**Severity:** Critical

**Problem:** The implementing agent receives the story description + ACs as text, but is **never told** about the acceptance test file or what it imports. The agent doesn't know:
- What file path the test imports from
- What function signatures the test expects
- What the test assertions actually check

The implementer builds whatever API makes sense, completely unaware the acceptance test expects `import { foo } from "../src/bar"`.

**Impact:** This is the **#1 root cause** of persistent acceptance failures. The two agents (test gen + implementer) are building against the same spec text but producing incompatible code.

---

### GAP 3: Fix Diagnosis Uses Shallow Import Resolution

**Stage:** `acceptance-loop` → `fix-diagnosis.ts`  
**Severity:** Medium

**Problem:** `diagnoseAcceptanceFailure()` calls `agent.run()` with a prompt, but:
- It only parses imports from the test file to find source files (via regex on `import ... from '...'`)
- `resolveImportPaths()` only handles relative imports — not package imports, aliases, or barrel exports
- It reads max 500 lines per source file and only up to 5 files
- The diagnosis prompt includes source files **it could find**, missing the files the test actually needs

**Impact:** Diagnosis often can't find the relevant source, defaults to `"source_bug"` with confidence 0, and the fix attempt operates blind.

---

### GAP 4: Fix Executor Prompt Is Too Thin

**Stage:** `acceptance-loop` → `fix-executor.ts`  
**Severity:** Medium

**Problem:** `buildSourceFixPrompt()` sends:
```
ACCEPTANCE TEST FAILURE: <output>
DIAGNOSIS: <reasoning>
ACCEPTANCE TEST FILE: <path>
Fix the source implementation. Do NOT modify the test file.
```

It tells the agent to fix source code but:
- Doesn't include the **test file content** in the prompt (only the path)
- Doesn't include what the test **imports** or **expects**
- The agent must independently discover what the test wants — same blind-implementation problem as Gap 2

**Impact:** Fix agent makes changes that still don't match what the test imports/expects.

---

### GAP 5: Test Regeneration Doesn't Learn From Previous Failure

**Stage:** `acceptance-loop` → `regenerateAcceptanceTest()`  
**Severity:** High

**Problem:** When `isTestLevelFailure()` triggers test regeneration:
1. Backs up old test → deletes → re-runs `acceptanceSetupStage.execute()`
2. The regenerated test is built from the SAME prompt with SAME ACs
3. No information about **why** the previous test failed is passed to the generator
4. No information about the **actual implementation** (now it exists!) is used

**Impact:** Regenerated test often has the same structural problems — wrong imports, wrong API assumptions. The implementation exists now but the generator doesn't use it.

---

### GAP 6: `acceptance-loop` Hardcodes `acceptance.test.ts` Path

**Stage:** `acceptance-loop.ts` lines ~130-135  
**Severity:** Medium

**Problem:** `loadAcceptanceTestContent()` and `generateAndAddFixStories()` hardcode `path.join(ctx.featureDir, "acceptance.test.ts")`, but `acceptance-setup` generates per-package files at `<packageDir>/.nax/features/<feature>/` with a configurable filename. The loop doesn't use `ctx.acceptanceTestPaths`.

**Impact:** In monorepos or non-default configs, the fix diagnosis reads the wrong (or non-existent) test file.

---

### GAP 7: Fix Stories Don't Get Acceptance Context

**Stage:** `acceptance-loop` → `generateAndAddFixStories()` → `executeFixStory()`  
**Severity:** Low

**Problem:** Fix stories go through the **full pipeline** including review stages, but:
- The `acceptanceTestPaths` from the original setup isn't carried through
- Fix stories don't have the acceptance test content in their context
- The agent implementing the fix gets the fix description but no pointer to what the test file actually asserts

---

### GAP 8: Semantic Review Verdicts Discarded Before Acceptance ⚠️ Critical

**Stage:** `iteration-runner.ts` → `acceptance-loop.ts`  
**Severity:** Critical

**Problem:** Semantic review (`src/review/semantic.ts`) validates each AC against the implementation diff per-story at pipeline stage 10. Its prompt explicitly says: "For each acceptance criterion, verify the diff implements it correctly." When semantic review passes, the LLM has confirmed the ACs are satisfied.

However:
- `iteration-runner.ts:133` sets `ctx.reviewResult = undefined` after each story iteration (GC cleanup for heap pressure — see #253)
- No per-story semantic verdict is persisted to disk
- The acceptance loop (`acceptance-loop.ts`) has zero access to semantic results
- When acceptance tests fail, diagnosis (`fix-diagnosis.ts`) starts from scratch — not knowing that semantic review already confirmed the implementation is correct

**Evidence:** `iteration-runner.ts:133` explicitly nulls `pipelineContext.reviewResult`, `pipelineContext.verifyResult`, and other heavy context fields. The acceptance stage (`acceptance.ts:112-249`) contains no reference to `reviewResult` or `reviewFindings`. The diagnosis prompt (`fix-diagnosis.ts:73-95`) includes only test output and source files — no semantic review context.

**Impact:** When semantic review passed but acceptance tests fail (a test-generation bug), the system defaults to `verdict: "source_bug"` with `confidence: 0` (`fix-diagnosis.ts:148-152`) and wastes retries trying to "fix" correct implementation code. This is the most expensive failure mode — it burns LLM calls on source fixes that can never succeed because the source is already correct.

---

### GAP 9: No Semantic-Aware Diagnosis Routing

**Stage:** `acceptance-loop.ts` → `fix-diagnosis.ts`  
**Severity:** High

**Problem:** The diagnosis prompt (`fix-diagnosis.ts:73-95`) asks "is this a source_bug or test_bug?" but has no information about whether semantic review already confirmed the ACs. The diagnosis operates as if no prior AC verification ever happened.

Additionally, `isTestLevelFailure()` (`acceptance-loop.ts:83-87`) only triggers test regeneration when >80% of ACs fail. If semantic review passed and 3 of 5 ACs fail due to import errors in the generated test (60%), it bypasses the heuristic and routes to source fixes on correct code.

**Evidence:** `isTestLevelFailure()` checks only `failedACs.length / totalACs > 0.8`. There is no semantic-aware branch. The diagnosis prompt in `buildDiagnosisPrompt()` includes `testOutput`, `testFileContent`, and `sourceFiles` — but not semantic review results.

**Impact:** The system cannot distinguish between "implementation is wrong" and "test was generated wrong against a correct implementation." When semantic review already confirmed correctness, this distinction is resolvable without an LLM diagnosis call — but the system doesn't have the signal.

---

## Summary Table

| Gap | Stage | Root Cause | Severity |
|:----|:------|:-----------|:---------|
| **GAP 8** | iteration-runner → acceptance-loop | Semantic verdicts GC'd before acceptance loop | **Critical** |
| **GAP 2** | execution | Implementer never sees acceptance test | **Critical** |
| **GAP 9** | acceptance-loop → fix-diagnosis | Diagnosis ignores semantic review pass signal | **High** |
| **GAP 1** | acceptance-setup | Test generated before implementation exists | **High** |
| **GAP 5** | acceptance-loop | Regeneration ignores existing implementation | **High** |
| **GAP 4** | fix-executor | Fix prompt has no test content | **Medium** |
| **GAP 3** | fix-diagnosis | Import resolution too shallow | **Medium** |
| **GAP 6** | acceptance-loop | Hardcoded test path vs per-package paths | **Medium** |
| **GAP 7** | acceptance-loop | Fix stories lack acceptance context | **Low** |

## Root Cause

There are two fundamental disconnects:

1. **Test generator ↔ Implementer blindness.** The test generator and the implementer are two ships passing in the night. Neither knows what the other is doing. The fix loop inherits this blindness.

2. **Semantic review ↔ Acceptance test isolation.** The system has TWO independent AC verification mechanisms — semantic review (per-story, stage 10) and acceptance tests (post-run) — that operate in complete isolation. Semantic review already confirms whether ACs are correctly implemented, but this verdict is garbage-collected before acceptance tests run. When acceptance tests fail on a semantically-verified implementation, the system has no way to know the implementation is correct and defaults to trying to fix it.

The highest-impact fixes would be:
1. **GAP 8** — persist semantic verdicts so the acceptance loop knows which ACs were already verified
2. **GAP 9** — use semantic pass as a strong prior toward "test_bug" in diagnosis routing
3. **GAP 2** — feed acceptance test paths/content to the implementer
4. **GAP 5** — regenerate tests using actual implementation when retrying
