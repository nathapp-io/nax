# Fix Plan: v0.9.1 — Routing Respect + TDD Isolation Rework

**Date:** 2026-02-22
**Branch:** fix/v0.9.1-routing-isolation
**Base:** Revert commits 211a884 and 4fa39a4, then apply clean fixes

## Context

Two commits (211a884, 4fa39a4) attempted to fix 4 issues but introduced problems:
1. `determineTestStrategy()` still overrides LLM complexity via keyword scan
2. Story count prompt hint isn't enforced
3. `analyzeConfig` metadata is fine but incomplete (missing naxVersion)
4. Isolation check now always passes (toothless)

This plan implements clean fixes for all 4 issues.

---

## Phase 1: Revert and Create Branch

1. `git revert --no-commit 4fa39a4 211a884` (revert both commits)
2. `git checkout -b fix/v0.9.1-routing-isolation`
3. Commit: `revert: undo 211a884 and 4fa39a4 for clean reimplementation`

---

## Phase 2: Fix Routing — LLM testStrategy in Decomposition

**Problem:** `determineTestStrategy()` re-scans keywords after LLM already classified complexity, overriding LLM decisions for simple tasks.

**Fix:** When `strategy=llm`, have the LLM output `testStrategy` directly in its decomposition response. `determineTestStrategy()` is only used for keyword-mode fallback.

### Changes:

**File: `src/agents/claude.ts`** (decomposition prompt)
- Add to the decomposition prompt schema: each story must include `testStrategy: "three-session-tdd" | "test-after"`
- Add decision rules to prompt:
  ```
  testStrategy rules:
  - "three-session-tdd": ONLY for complex/expert tasks that are security-critical (auth, encryption, tokens) or define public API contracts
  - "test-after": for all other tasks including simple/medium complexity
  - A task being "simple" complexity should almost never be three-session-tdd
  ```
- Add `testStrategy` to the expected JSON response schema alongside existing `complexity` field

**File: `src/cli/analyze.ts`**
- When building UserStory from LLM decomposition result:
  - Use `ds.testStrategy` directly (from LLM response) instead of calling `determineTestStrategy()`
  - Fallback to `determineTestStrategy()` only if LLM didn't return a testStrategy
- When using keyword classification (non-LLM path): keep calling `determineTestStrategy()` as-is
- Add `routing.strategy: "llm" | "keyword"` and `routing.llmModel` to the story routing object

**File: `src/prd/types.ts`**
- Add to `StoryRouting`:
  ```ts
  strategy?: "keyword" | "llm";
  llmModel?: string;
  ```

### Tests:
- Update existing analyze tests to verify LLM-classified stories use LLM's testStrategy
- Add test: simple story with "auth" in tags gets `test-after` from LLM (not overridden to three-session-tdd)

---

## Phase 3: Enforce Max Stories + Add analyzeConfig

**Problem:** Prompt hint for max stories isn't enforced. analyzeConfig missing naxVersion.

### Changes:

**File: `src/agents/claude.ts`** (decomposition prompt)
- Add grouping guidelines (from 211a884 — this part was good):
  ```
  Grouping Guidelines:
  - Combine small related tasks into single stories
  - Maximum stories: {maxStories} (from config). If you generate more, merge related ones.
  - Aim for coherent units of value
  ```
- Pass `maxStories` from config into the prompt template

**File: `src/cli/analyze.ts`**
- After LLM returns stories, if count > `config.execution.maxStoriesPerFeature`:
  - Log a warning: `"LLM returned {n} stories, exceeding max {max}. Consider re-running with stricter grouping."`
  - Do NOT auto-truncate (could lose important work). Just warn.
- Add `analyzeConfig` to PRD output:
  ```ts
  analyzeConfig: {
    naxVersion: pkg.version,  // read from package.json
    model: config.analyze.model,
    llmEnhanced: config.analyze.llmEnhanced,
    maxStoriesPerFeature: config.execution.maxStoriesPerFeature,
    routingStrategy: config.analyze.llmEnhanced ? "llm" : "keyword",
  }
  ```

**File: `src/prd/types.ts`**
- Add to PRD interface:
  ```ts
  analyzeConfig?: {
    naxVersion: string;
    model: string;
    llmEnhanced: boolean;
    maxStoriesPerFeature: number;
    routingStrategy: "keyword" | "llm";
  };
  ```

### Tests:
- Test that analyzeConfig is populated with correct values
- Test warning logged when stories exceed max

---

## Phase 4: TDD Isolation — Detector + Verifier Judgment

**Problem:** Isolation check always passes after 211a884. Should detect and report, let verifier judge.

### Changes:

**File: `src/tdd/types.ts`**
- Update `IsolationCheck`:
  ```ts
  interface IsolationCheck {
    /** Whether strict isolation was maintained (no test files touched) */
    strictPass: boolean;
    /** Test files modified by implementer */
    modifiedTestFiles: string[];
    /** Verdict: clean (no changes), needs-review (verifier must judge) */
    verdict: "clean" | "needs-review";
    description: string;
  }
  ```

**File: `src/tdd/isolation.ts`**
- `verifyImplementerIsolation()` returns honest results:
  - If no test files modified: `{ strictPass: true, modifiedTestFiles: [], verdict: "clean" }`
  - If test files modified: `{ strictPass: false, modifiedTestFiles: [...], verdict: "needs-review" }`
  - Do NOT return `passed: true` when files were modified

**File: `src/tdd/orchestrator.ts`**
- After Session 2 isolation check:
  - If `verdict === "clean"`: proceed normally
  - If `verdict === "needs-review"`: inject modified file info into verifier (Session 3) prompt
- Update verifier prompt:
  ```
  ⚠️ ISOLATION REVIEW REQUIRED
  The implementer modified these test files: {modifiedTestFiles}
  
  You MUST review the changes to these files and determine:
  - LEGITIMATE: Fixing genuinely incorrect test expectations, adding missing imports,
    adjusting test fixtures to match correct implementation behavior
  - VIOLATION: Removing test cases, weakening assertions, deleting acceptance criteria
    checks, adding tests to inflate pass rate
  
  Include your verdict in the output:
  - isolationVerdict: "approved" | "rejected"
  - isolationReason: "<explanation>"
  
  If REJECTED: fail the story.
  ```
- Parse verifier output for isolation verdict
- Log the verdict (approved/rejected + reason) to structured JSONL

**File: `src/tdd/orchestrator.ts`** (runTddSession result handling)
- When isolation.verdict === "needs-review" and verifier says "rejected":
  - Mark story as failed with reason "TDD isolation violation confirmed by verifier"
- When isolation.verdict === "needs-review" and verifier says "approved":
  - Mark story as passed with warning logged

### Tests:
- Test isolation detection: modified test files → verdict "needs-review"
- Test clean isolation: no test files → verdict "clean"  
- Test orchestrator injects isolation context into verifier prompt when needs-review
- Test story fails when verifier rejects isolation

---

## Phase 5: Version Bump + Cleanup

1. Bump version to `0.9.1` in `package.json`
2. Run full test suite: `bun test`
3. Commit: `fix(v0.9.1): routing respects LLM complexity, isolation reworked to detector+verifier`
4. Do NOT push.

---

## Test Strategy
- Mode: test-after
- Reason: Internal refactor with existing test coverage. Tests updated alongside implementation per phase.

## Commits
- Phase 1: `revert: undo 211a884 and 4fa39a4 for clean reimplementation`
- Phase 2: `fix(routing): LLM decomposition outputs testStrategy directly`
- Phase 3: `fix(analyze): enforce max stories warning, add analyzeConfig with naxVersion`
- Phase 4: `fix(tdd): isolation becomes detector, verifier makes judgment`
- Phase 5: `chore: bump to v0.9.1`
