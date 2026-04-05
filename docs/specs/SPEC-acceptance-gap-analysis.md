# Acceptance Pipeline Gap Analysis

*Authored: 2026-04-05 by Nax Dev (Claude Opus 4)*

## Overview

Analysis of the full acceptance test lifecycle — from generation through fix — identifying gaps that cause acceptance tests to persistently fail even when the feature implementation is correct.

## End-to-End Flow

```
1. acceptance-setup    → refine ACs → LLM generates test file → RED gate
2. execution stages    → agent implements the feature
3. acceptance stage    → runs test file → pass/fail
4. acceptance-loop     → diagnose → fix/regen → re-run acceptance → repeat
```

## Key Source Files

| File | Role |
|:-----|:-----|
| `src/pipeline/stages/acceptance-setup.ts` | Generates acceptance tests pre-implementation |
| `src/acceptance/generator.ts` | LLM-based test code generation |
| `src/acceptance/refinement.ts` | Refines raw ACs into testable assertions |
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

## Summary Table

| Gap | Stage | Root Cause | Severity |
|:----|:------|:-----------|:---------|
| **GAP 2** | execution | Implementer never sees acceptance test | **Critical** |
| **GAP 1** | acceptance-setup | Test generated before implementation exists | **High** |
| **GAP 5** | acceptance-loop | Regeneration ignores existing implementation | **High** |
| **GAP 4** | fix-executor | Fix prompt has no test content | **Medium** |
| **GAP 3** | fix-diagnosis | Import resolution too shallow | **Medium** |
| **GAP 6** | acceptance-loop | Hardcoded test path vs per-package paths | **Medium** |
| **GAP 7** | acceptance-loop | Fix stories lack acceptance context | **Low** |

## Root Cause

The fundamental problem: **the test generator and the implementer are two ships passing in the night.** Neither knows what the other is doing. The fix loop inherits this blindness.

The highest-impact fixes would be:
1. **GAP 2** — feed acceptance test paths/content to the implementer
2. **GAP 5** — regenerate tests using actual implementation when retrying
