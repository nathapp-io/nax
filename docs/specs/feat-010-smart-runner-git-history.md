# FEAT-010 — Smart Test Runner: Git-History Mode

**Status:** Proposal
**Target:** v0.21.0
**Author:** Nax Dev
**Date:** 2026-03-06

---

## 1. Problem with Current Approach

Smart Test Runner uses `git diff --name-only HEAD` (or `HEAD~1`) to find changed files. This breaks in several scenarios:

| Scenario | Problem |
|---|---|
| Agent makes 3 commits | `HEAD~1` only sees last commit; earlier changes missed |
| Agent uses `git commit --amend` | HEAD stays same; diff shows nothing |
| Uncommitted staged changes | Picks up unrelated staged changes |
| Story retried after partial commit | Baseline resets to wrong point |

Result: empty `[]` → full suite fallback (150s+) → deferred mode skips → no per-story tests.

---

## 2. Proposed Solution

Track a **baseCommitHash** per story at session start. On verify, diff `HEAD` vs `baseCommitHash` — exact files the agent touched regardless of commit count.

```
Story starts → capture git HEAD → store as story.baseRef
Agent runs   → makes N commits (any pattern)
Verify runs  → git diff --name-only story.baseRef HEAD → precise file list
```

---

## 3. Implementation Details

**Capture baseRef** in `sequential-executor.ts` before agent launch:
```typescript
story.baseRef = await captureGitRef(workdir);  // already exists in utils/git.ts
await savePrd(prd, prdPath);
```

**New mode branch** in `smart-runner.ts`:
```typescript
if (mode === "git-history" && story?.baseRef) {
  return gitWithTimeout(["diff", "--name-only", story.baseRef, "HEAD"], workdir);
}
// fallback: existing git-diff logic
```

---

## 4. Files Affected

| File | Change |
|---|---|
| `src/prd/types.ts` | Add `baseRef?: string` to `UserStory` |
| `src/execution/sequential-executor.ts` | Capture `baseRef` before agent, persist to PRD |
| `src/verification/smart-runner.ts` | Add `"git-history"` mode |
| `src/config/schemas.ts` | Add `smartTestRunner.mode: "git-diff" | "git-history"` |
| `src/config/types.ts` | Add `mode` to `SmartTestRunnerConfig` |

---

## 5. Config Changes

```jsonc
{
  "execution": {
    "smartTestRunnerConfig": {
      "mode": "git-history",   // "git-diff" (default) | "git-history"
      "enabled": true
    }
  }
}
```

---

## 6. Migration / Compatibility

- Default: `"git-diff"` — no behavior change
- `"git-history"` opt-in
- Missing `story.baseRef` → falls back to `"git-diff"` (no crash)
- nax self-dev config should switch to `"git-history"` immediately

---

## 7. Test Plan

- `baseRef` captured and persisted before agent runs
- Multi-commit session: all files detected (not just last commit's)
- Missing `baseRef` → graceful fallback to `"git-diff"`
- `captureGitRef()` failure → `baseRef` undefined, fallback used
