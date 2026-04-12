---
title: Parallel Execution
description: Running multiple stories concurrently with git worktrees
---

## Parallel Execution

nax can run multiple stories concurrently using git worktrees — each story gets an isolated worktree so agents don't step on each other.

```bash
# Auto concurrency (based on CPU cores)
nax run -f my-feature --parallel 0

# Fixed concurrency
nax run -f my-feature --parallel 3
```

**How it works:**

1. Stories are grouped by dependency order (dependent stories wait for their prerequisites)
2. Each batch of independent stories gets its own git worktree
3. Agent sessions run concurrently inside those worktrees
4. Once a batch completes, changes are merged back in dependency order
5. Merge conflicts are automatically rectified by re-running the conflicted story on the updated base

**Config:**

```json
{
  "execution": {
    "maxParallelSessions": 4
  }
}
```

> Sequential mode (no `--parallel`) is the safe default. Use parallel for large feature sets with independent stories.

---

## Sequential Worktree Isolation (EXEC-002)

Even in sequential mode, nax can isolate each story in its own git worktree. This prevents cross-story state leakage where one story's changes affect the next story's execution environment.

```json
{
  "execution": {
    "storyIsolation": "worktree"
  }
}
```

**Per-story worktree lifecycle:**

1. **Create** — `git worktree add .nax-wt/<storyId>` at story start
2. **Execute** — story runs in the isolated worktree (no cross-story state)
3. **Merge** — successful changes are merged back to the main branch
4. **Cleanup** — worktree directory is removed via `git worktree remove` (reclaims disk)
5. **Preserve branch** — `nax/<storyId>` branch is kept for diagnostics and re-run cleanup

**Paused story handling:** When `storyIsolation === "worktree"`, re-running paused stories clears `storyGitRef` so it is re-captured in a fresh worktree. The user is prompted interactively for each paused story: resume, skip, or keep paused.

**Key files:**
- `src/execution/pipeline-result-handler.ts` — worktree cleanup + pipeline outcome handling
- `src/execution/lifecycle/paused-story-prompts.ts` — interactive paused story prompts

---

[Back to README](../../README.md)
