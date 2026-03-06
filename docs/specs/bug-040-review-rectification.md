# BUG-040 — Review Rectification Loop

**Status:** Proposal
**Target:** v0.21.0
**Author:** Nax Dev
**Date:** 2026-03-06

---

## 1. Problem

A story that fails lint or typecheck during the review stage is **permanently killed** — no retry, no agent fix, immediate escalation. This wastes an entire escalation slot on a trivial auto-fixable error.

**Example:** Agent implements story correctly. All tests pass (verify ✅). Review runs `biome check` → 3 lint errors. Review returns `{ action: "fail" }` → story marked failed → escalates to `balanced` → `balanced` agent re-implements from scratch → also gets lint errors → `powerful` tier used. All for a `biome --fix` that takes 2 seconds.

---

## 2. Root Cause

```
review.ts:execute() → runReview() → { success: false }
  → return { action: "fail" }        ← always "fail" for any review failure

pipeline-result-handler.ts
  case "fail": markStoryFailed()     ← permanent, no retry
```

The verify stage correctly returns `"escalate"` on test failure, enabling rectification. Review has no equivalent.

---

## 3. Proposed Architecture

```
review.ts → runReview() fails
  → return { action: "review-rectify", output }   ← NEW

pipeline-result-handler.ts
  case "review-rectify":
    → runReviewRectification(story, reviewOutput, config, workdir)
        → agent: "Fix these lint/typecheck errors:\n<output>"
        → re-run review
        → pass?  → "continue"
        → fail?  → "escalate" (if attempts exhausted)
```

---

## 4. Files Affected

| File | Change |
|---|---|
| `src/pipeline/stages/review.ts` | Return `{ action: "review-rectify", output }` instead of `"fail"` |
| `src/pipeline/types.ts` | Add `"review-rectify"` to `StageAction` union |
| `src/execution/pipeline-result-handler.ts` | Handle `"review-rectify"` → call `runReviewRectification()` |
| `src/execution/review-rectification.ts` | **New:** `runReviewRectification()` loop |
| `src/config/schemas.ts` | Add `review.maxRectificationAttempts` (default: 1) |
| `src/config/types.ts` | Add `maxRectificationAttempts` to `ReviewConfig` |

---

## 5. Config Changes

```jsonc
{
  "review": {
    "enabled": true,
    "checks": ["typecheck", "lint"],
    "maxRectificationAttempts": 1   // 0 = revert to old "fail" behavior
  }
}
```

---

## 6. Test Plan

- Lint failure → `runReviewRectification()` called with lint output
- Rectification passes → story continues (not escalated)
- Rectification fails → story escalates (not permanently failed)
- `maxRectificationAttempts: 0` → old behavior (immediate escalate)
- Plugin reviewer rejection → still `"fail"` (not routed through rectification)
