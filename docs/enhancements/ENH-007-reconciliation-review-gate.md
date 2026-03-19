# ENH-007: Reconciliation — re-run review before auto-passing failed stories

**Type:** Enhancement  
**Component:** `src/execution/lifecycle/run-initialization.ts`  
**Filed:** 2026-03-19  
**Status:** Done  
**Source:** Post-mortem koda/fix/refactor-standard (ENH-002)

## Problem

Reconciliation marks failed stories as "passed" if they have commits in git history:

```
[warn][reconciliation] Failed story has commits in git history, marking as passed
```

But commits ≠ quality. In the koda run, US-002-2 failed at review (typecheck errors) and was auto-passed by reconciliation. US-002-3 then built on broken code.

## Root Cause

`reconcileState()` in `run-initialization.ts` only checks `hasCommitsForStory()` — a pure git check. It has no information about *why* a story failed, so it can't distinguish between:

- A story that failed at coding stage (commits = probably good enough)
- A story that failed at review stage (commits exist but code doesn't pass typecheck/lint)

## Design: A + B Approach

### Part A: Store `failureStage` on failed stories

Record which pipeline stage caused the failure so reconciliation can make informed decisions.

**New field on `UserStory`:**

```typescript
// src/prd/types.ts
interface UserStory {
  // ... existing fields ...
  /** Pipeline stage where this story last failed (set by markStoryFailed) */
  failureStage?: string;
}
```

**Extend `markStoryFailed`:**

```typescript
// src/prd/index.ts
export function markStoryFailed(
  prd: PRD,
  storyId: string,
  failureCategory?: FailureCategory,
  failureStage?: string,    // NEW — e.g. "review", "autofix", "coding", "verify"
): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.status = "failed";
    story.attempts += 1;
    if (failureCategory !== undefined) story.failureCategory = failureCategory;
    if (failureStage !== undefined) story.failureStage = failureStage;
  }
}
```

### Part B: Re-run review checks during reconciliation

When a story has `failureStage` of `"review"` or `"autofix"` (autofix = review loop exhausted), re-run built-in review checks before reconciling.

**Updated `reconcileState()`:**

```typescript
// src/execution/lifecycle/run-initialization.ts
async function reconcileState(
  prd: PRD,
  prdPath: string,
  workdir: string,
  config: NaxConfig,    // NEW — needed to resolve review config
): Promise<PRD> {
  const logger = getSafeLogger();
  let reconciledCount = 0;
  let modified = false;

  for (const story of prd.userStories) {
    if (story.status !== "failed") continue;
    
    const hasCommits = await hasCommitsForStory(workdir, story.id);
    if (!hasCommits) continue;

    // Gate: re-run review for stories that failed at review/autofix stage
    if (story.failureStage === "review" || story.failureStage === "autofix") {
      const effectiveWorkdir = story.workdir
        ? join(workdir, story.workdir)
        : workdir;
      const reviewResult = await _reconcileDeps.runReview(
        config.review,
        effectiveWorkdir,
        config.execution,
      );

      if (!reviewResult.success) {
        logger?.warn("reconciliation", "Review still fails — not reconciling", {
          storyId: story.id,
          failureReason: reviewResult.failureReason,
        });
        continue; // skip reconciliation
      }

      logger?.info("reconciliation", "Review now passes — reconciling", {
        storyId: story.id,
      });
    }

    // Reconcile: mark as passed
    markStoryPassed(prd, story.id);
    reconciledCount++;
    modified = true;
  }

  if (reconciledCount > 0) {
    logger?.info("reconciliation", `Reconciled ${reconciledCount} failed stories`, {});
    await savePRD(prd, prdPath);
  }

  return prd;
}
```

### Why both A and B?

- **A alone** — knows the failure type but can't tell if it's fixed now
- **B alone** — works but re-runs review for ALL failures (slow, unnecessary for coding-stage failures)
- **A + B** — only re-runs review when `failureStage` is review-related; trusts commits for other stages

## Files to Change

| # | File | Change | Lines |
|:--|:-----|:-------|:------|
| 1 | `src/prd/types.ts` | Add `failureStage?: string` to `UserStory` | +2 |
| 2 | `src/prd/index.ts` | Add `failureStage` param to `markStoryFailed` | +3 |
| 3 | `src/execution/pipeline-result-handler.ts` | Pass `pipelineResult.stoppedAtStage` to `markStoryFailed` | +1 per call site (2 sites: `"fail"` case + escalation) |
| 4 | `src/execution/escalation/tier-outcome.ts` | Same — pass `stoppedAtStage` through escalation | +1 per call site (2 sites) |
| 5 | `src/execution/escalation/tier-escalation.ts` | Same — 1 call site | +1 |
| 6 | `src/execution/parallel-coordinator.ts` | Same — 3 call sites (pass stage if available) | +3 |
| 7 | `src/execution/lifecycle/run-initialization.ts` | Add review gate to `reconcileState()`, accept `config` param, add `_reconcileDeps` | ~25 |
| 8 | `test/unit/execution/lifecycle/run-initialization.test.ts` | **New file** — test reconciliation behavior | ~120 |

**Total: 7 files modified, 1 new test file**

## Callers of `markStoryFailed` (all must be updated)

```
src/execution/pipeline-result-handler.ts:138   → has pipelineResult.stoppedAtStage ✓
src/execution/escalation/tier-escalation.ts:153 → need stoppedAtStage from escalation context
src/execution/escalation/tier-outcome.ts:59     → need stoppedAtStage from escalation context
src/execution/escalation/tier-outcome.ts:122    → same
src/execution/parallel-coordinator.ts:174       → may not have stage info (mark undefined)
src/execution/parallel-coordinator.ts:221       → merge failure (not stage-related, leave undefined)
src/execution/parallel-coordinator.ts:244       → same
```

## `_reconcileDeps` (injectable for testing)

```typescript
export const _reconcileDeps = {
  runReview: async (
    reviewConfig: ReviewConfig,
    workdir: string,
    executionConfig: NaxConfig["execution"],
  ) => {
    const { runReview } = await import("../../review/runner");
    return runReview(reviewConfig, workdir, executionConfig);
  },
};
```

## Test Plan

| Test | Input | Expected |
|:-----|:------|:---------|
| Backward compat: no failureStage | `status: "failed"`, has commits, no `failureStage` | Reconciles as passed (existing behavior) |
| Review failure, review now passes | `failureStage: "review"`, has commits, mock review → success | Reconciles as passed |
| Review failure, review still fails | `failureStage: "review"`, has commits, mock review → fail | NOT reconciled, stays failed |
| Autofix failure, review now passes | `failureStage: "autofix"`, has commits, mock review → success | Reconciles as passed |
| Coding failure with commits | `failureStage: "coding"`, has commits | Reconciles as passed (trust commits) |
| No commits | `failureStage: "review"`, no commits | NOT reconciled (existing behavior) |
| Workdir scoping | `failureStage: "review"`, `story.workdir: "packages/api"` | Review runs against `join(workdir, story.workdir)` |

## Edge Cases

1. **No failureStage (old prd.json)** — backward compat: reconcile as before (commits = passed)
2. **Multiple re-runs** — if review still fails, story stays `"failed"` with same `failureStage`. Next run will re-check again. This is correct — a manual fix between runs should be detected.
3. **Review config disabled** — if `review.enabled === false`, the review gate should skip (nothing to re-run). Reconcile as passed.
4. **Monorepo workdir** — use `story.workdir` to scope the review check (already handled in design above)

## Acceptance Criteria

- [ ] Failed stories store `failureStage` in prd.json
- [ ] Reconciliation re-runs review for `failureStage === "review" | "autofix"`
- [ ] Stories with still-failing review are NOT reconciled
- [ ] Stories with no `failureStage` (backward compat) reconcile as before
- [ ] Stories that failed at other stages (coding, verify) reconcile as before
- [ ] Workdir-scoped review for monorepo stories
- [ ] All 7 test cases pass
