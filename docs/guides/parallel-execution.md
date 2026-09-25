---
title: Parallel Execution
description: Running multiple stories concurrently with git worktrees
---

## Parallel Execution

nax can run multiple stories concurrently using git worktrees — each story gets an isolated worktree so agents don't step on each other.

```bash
# Up to 3 stories at a time
nax run -f my-feature --parallel 3
```

**How it works:**

1. Ready stories whose dependencies are satisfied are selected as an independent batch (up to `<n>`); dependent stories wait for their prerequisites
2. Each story in the batch gets its own git worktree
3. Agent sessions run concurrently inside those worktrees
4. Once a batch completes, each story's `nax/<worktreeId>` branch is merged back (`git merge --no-ff`) in dependency order
5. Merge conflicts are automatically rectified by re-running the conflicted story on the updated base (`src/execution/merge-conflict-rectify.ts`); non-conflict merge errors fail the story instead

**Concurrency** is controlled by the `--parallel <n>` flag (omit = sequential). There is no `execution.maxParallelSessions` config key — concurrency is a per-run CLI choice.

> **`--parallel 0`:** the CLI help and `RunOptions` describe `0` as "auto", but no auto-detection is implemented — the executor only dispatches batches when `n > 0`, so `--parallel 0` currently runs sequentially (while the deferred regression gate still treats the run as parallel and falls back to git-recency blame). Pass an explicit count.

> A retry of a previously failed story always runs alone, pre-empting batch selection.

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

`storyIsolation` defaults to `"shared"` (all stories run in the main checkout).

**Per-story worktree lifecycle:**

1. **Create** — `git worktree add .nax-wt/<worktreeId>` on branch `nax/<worktreeId>` at story start
2. **Execute** — story runs in the isolated worktree (no cross-story state)
3. **Merge** — on success, the branch is merged back with `--no-ff`, then the worktree and branch are removed
4. **Fail** — when all tiers are exhausted, the worktree directory is removed but the `nax/<worktreeId>` branch is kept for diagnostics; nax records ownership in `refs/nax/orphan/<worktreeId>` so the next run's worktree creation can safely delete and recreate it

### Worktree identity

Worktree paths, branches, and orphan refs are all derived from a branded `WorktreeId` (`src/worktree/worktree-id.ts`) — never from the raw story ID. A story's ID is `story-<feature>-<storyId>`, sanitized and capped at 64 characters (a stable hash suffix disambiguates truncated IDs), so two features with the same story ID never collide. Bakeoff contestants use `bakeoff-<feature>-<profile>`.

### Worktree dependencies

Worktrees live inside the project root (`<root>/.nax-wt/`), so Node/Bun module resolution walks up to the root `node_modules` and needs no install. Ecosystems without that upward walk (Python venvs, bundler, composer) can provision each worktree:

```json
{
  "execution": {
    "worktreeDependencies": {
      "mode": "provision",
      "setupCommand": "uv sync",
      "timeoutSeconds": 300
    }
  }
}
```

| Field | Default | Description |
|:------|:--------|:------------|
| `mode` | `"off"` | `"off"` installs nothing; `"provision"` runs `setupCommand` in the worktree before the story |
| `setupCommand` | `null` | Required when `mode` is `"provision"`; rejected otherwise |
| `timeoutSeconds` | `300` | Hard deadline for the setup command (1–3600) |

**Paused story handling:** When `storyIsolation === "worktree"`, re-running paused stories clears `storyGitRef` so it is re-captured in a fresh worktree. The user is prompted interactively for each paused story: resume, skip, or keep paused (headless runs skip the prompt and leave paused stories paused).

**Key files:**
- `src/execution/pipeline-result-handler.ts` — worktree merge/cleanup + pipeline outcome handling
- `src/worktree/manager.ts`, `src/worktree/merge.ts` — worktree create/remove and merge engine
- `src/worktree/worktree-id.ts` — `WorktreeId` derivation (SSOT for path/branch/ref spellings)
- `src/execution/lifecycle/paused-story-prompts.ts` — interactive paused story prompts

---

[Back to README](../../README.md)
