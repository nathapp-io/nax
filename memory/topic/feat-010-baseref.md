# FEAT-010 — baseRef Tracking Design Decision

## Decision
Capture `baseRef = current HEAD` **in-memory at each attempt start** (not stored in PRD).
Use `git diff <baseRef>..HEAD` in smart-runner instead of `HEAD~1`.

## Why per-attempt, not per-story
- Story may retry after other stories have committed
- Storing in PRD: retry would use stale baseRef from first attempt → includes other stories' files ❌
- Capturing fresh per attempt: retry anchors to HEAD at that moment → only sees its own commits ✅

## Why no cross-story pollution
- Story 1 retry baseRef = HEAD after stories 2+3 committed
- diff <baseRef>..HEAD = only story 1 retry's own commits
- Other stories' commits are BEFORE baseRef → excluded automatically

## Flow
```
attempt start → captureGitRef() → baseRef (in-memory)
agent runs → makes N commits
verify → getChangedSourceFiles(workdir, baseRef)
         → git diff <baseRef>..HEAD
         → only this attempt's changed files ✅
```

## Edge Cases
- Agent makes 0 commits → diff = empty → fallback to full suite (existing behavior)
- Partial commits on failure → next attempt captures new baseRef → clean isolation
