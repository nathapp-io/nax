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

[Back to README](../../README.md)
