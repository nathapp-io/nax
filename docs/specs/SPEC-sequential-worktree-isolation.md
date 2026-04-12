# SPEC: Sequential Worktree Isolation (EXEC-002)

## Summary

Add a configurable `execution.storyIsolation` mode that runs each story in its own git worktree, even in sequential mode. On success, merge the worktree branch back to main. On failure, the branch stays separate — failed commits never land on main. On re-run, a fresh worktree branches from the current (clean) main.

This eliminates the `storyGitRef` cross-story pollution bug: since each worktree is isolated, `storyGitRef..HEAD` always contains only that story's commits, regardless of how many stories ran before or how many re-runs occurred.

The feature reuses the existing parallel worktree infrastructure (`src/worktree/manager.ts`, `src/worktree/merge.ts`, `src/execution/merge-conflict-rectify.ts`).

## Motivation

### The cross-story pollution bug

When multiple stories exhaust all tiers and are marked `"failed"`, then the user re-runs `nax run`:

```
Run 1:
  US-001(ref=A): commits B..F → FAILED
  US-002(ref=F): commits G..J → FAILED
  US-003(ref=J): commits K..M → FAILED

Run 2 (re-run):
  US-001 re-runs, storyGitRef still = A
  git diff A..HEAD = US-001 + US-002 + US-003 changes
  → semantic review sees 3 stories' worth of changes for 1 story
```

The stopgap fix (`resetRefOnRerun` in SPEC-semantic-review-diff-mode.md US-005) trades cross-story pollution for under-scoping. Neither is correct.

### Failed commits pollute main

In the current model, all agent commits land on the same branch regardless of outcome. After US-001 exhausts all tiers, its failed implementation (commits B..F) stays in the working tree. When US-002 starts, its agent sees US-001's broken code in the codebase. When the user re-runs US-001, the agent starts on top of all prior failures.

### Worktree isolation solves both problems

Each story's commits live on an isolated `nax/<storyId>` branch:
- `storyGitRef..HEAD` in the worktree = only that story's commits (always)
- Failed commits never merge to main → clean codebase for the next story
- Re-run creates a fresh branch from current main → clean slate

## Design

### Config

```json
{
  "execution": {
    "storyIsolation": "shared"
  }
}
```

- `storyIsolation`: `"shared"` | `"worktree"` (default: `"shared"`)
  - `"shared"`: current behaviour — all stories run on the same branch
  - `"worktree"`: each story runs in its own git worktree

### Execution Flow: `"worktree"` mode

#### First run

```
main: A ─────────────── A' (US-001 merge) ─── A'' (US-002 merge) ─── ...
       \               /                     /
        nax/US-001: B,C,D,E,F (PASSED) ────┘
                                    \
                                     nax/US-002: G,H,I (PASSED) ───┘
```

```
Iter 1:
  1. worktreeManager.create(projectRoot, "US-001")
     → .nax-wt/US-001/ with branch nax/US-001 from main HEAD
  2. iteration-runner runs pipeline in .nax-wt/US-001/
     storyGitRef = branch point (main HEAD before story)
  3. Pipeline PASSES
  4. mergeEngine.merge(projectRoot, "US-001")
     → nax/US-001 merged into main with --no-ff
     → worktree removed
  5. story marked "passed"

Iter 2:
  1. worktreeManager.create(projectRoot, "US-002")
     → branches from main HEAD (now includes US-001's merge)
  2. iteration-runner runs pipeline in .nax-wt/US-002/
  ...
```

#### Failed story (no merge to main)

```
main: A ──────────────────────── A' (US-002 merge, clean) ─── ...
       \                        /
        nax/US-001: B,C,D,E,F (FAILED — branch kept, NOT merged)
         \
          nax/US-002: G,H,I (PASSED — branched from A, not polluted) ──┘
```

```
Iter 1:
  1. Create worktree for US-001, run pipeline → FAILS (fast tier)
  2. Escalate: US-001 retries in SAME worktree (balanced tier)
     → storyGitRef still points to branch point
     → git diff storyGitRef..HEAD = only US-001 commits (always)
  3. All tiers exhausted → US-001 marked "failed"
  4. Worktree kept (branch nax/US-001 preserved for potential re-run)
     Main is untouched — no failed commits

Iter 2:
  1. Create worktree for US-002, branches from main HEAD (= A, clean)
  2. US-002 runs → PASSES → merge to main
```

**Key:** US-002's agent starts from a clean main (commit A), not from a codebase polluted by US-001's failed implementation. US-002 can't accidentally depend on US-001's broken code.

#### Re-run after failure

```
Run 2:
  1. initializeRun detects US-001 is "failed" with existing branch nax/US-001
  2. resetFailedStoriesToPending:
     - storyIsolation === "worktree": delete old nax/US-001 branch
     - story.storyGitRef = undefined (will be re-captured)
  3. US-001 runs:
     - Fresh worktree from main HEAD (now includes US-002's merge)
     - storyGitRef = main HEAD (clean baseline)
     - Agent starts with US-002's code in the codebase (correct — US-002 passed)
     - git diff storyGitRef..HEAD = only this re-run's commits
```

**No cross-story pollution possible**, regardless of how many stories failed or how many re-runs occur.

#### Escalation within worktree

During escalation (fast → balanced → powerful), the story stays in the **same worktree**:

```
nax/US-001 worktree:
  storyGitRef = branch point
  Attempt 1 (fast): commits B,C,D → FAIL
  Attempt 2 (balanced): commits E,F → FAIL
  Attempt 3 (powerful): commits G,H → FAIL
  → all tiers exhausted, worktree branch kept
```

`git diff storyGitRef..HEAD` in the worktree always shows only US-001's commits. No other story's work is on this branch. This is identical to the current within-run behaviour (Flow 1) but now also survives re-runs.

### Integration Points

#### iteration-runner.ts

Currently runs the pipeline in `ctx.workdir` (the project root). In worktree mode:

```typescript
// Before pipeline execution
let effectiveWorkdir = ctx.workdir;
if (ctx.config.execution.storyIsolation === "worktree") {
  await worktreeManager.create(ctx.workdir, story.id);
  effectiveWorkdir = join(ctx.workdir, ".nax-wt", story.id);
}

// storyGitRef capture happens in effectiveWorkdir (always correct)
const storyGitRef = await captureGitRef(effectiveWorkdir);

// Pipeline runs in effectiveWorkdir
const pipelineContext: PipelineContext = {
  ...ctx,
  workdir: effectiveWorkdir,
  storyGitRef,
};
```

#### pipeline-result-handler.ts (success path)

After pipeline passes, merge the worktree branch:

```typescript
if (config.execution.storyIsolation === "worktree") {
  const mergeResult = await mergeEngine.merge(ctx.workdir, story.id);
  if (!mergeResult.success) {
    // Merge conflict after story passed all checks
    // Attempt rectification (same as parallel mode)
    const rectifyResult = await rectifyConflictedStory({ ... });
    if (!rectifyResult.rectified) {
      // Story passed review but can't merge — mark as failed
      return { ... outcome: "merge-conflict" };
    }
  }
  // After successful merge, worktree is cleaned up by mergeEngine
}
```

#### pipeline-result-handler.ts (failure path — escalation)

On escalation, the story stays in the **same worktree**. No merge, no cleanup. The next iteration picks up the same story (Flow 1) and runs in the same worktree directory.

```typescript
if (config.execution.storyIsolation === "worktree") {
  // Do NOT merge or clean up — story will retry in same worktree
  // storyGitRef stays valid (points to branch point in this worktree)
}
```

#### pipeline-result-handler.ts (failure path — exhaustion)

When all tiers are exhausted, the worktree branch is kept for potential re-run:

```typescript
if (config.execution.storyIsolation === "worktree") {
  // Keep the worktree branch (nax/US-001) for diagnostics
  // Remove the worktree directory to save disk
  await worktreeManager.remove(ctx.workdir, story.id);
  // Branch stays in git for inspection: git log nax/US-001
}
```

#### run-initialization.ts (re-run cleanup)

On re-run, delete old worktree branches for stories being retried:

```typescript
if (config.execution.storyIsolation === "worktree") {
  for (const story of resetStories) {
    // Delete old branch so worktreeManager.create() starts clean
    await spawn(["git", "branch", "-D", `nax/${story.id}`], { cwd: workdir });
    story.storyGitRef = undefined;  // force re-capture in new worktree
  }
}
```

### Reused Infrastructure

| Component | Source | Reuse |
|:----------|:-------|:------|
| `WorktreeManager.create()` | `src/worktree/manager.ts` | Direct — creates `.nax-wt/<storyId>/` with branch `nax/<storyId>` |
| `WorktreeManager.remove()` | `src/worktree/manager.ts` | Direct — cleanup after merge or exhaustion |
| `MergeEngine.merge()` | `src/worktree/merge.ts` | Direct — merges `nax/<storyId>` into main with `--no-ff` |
| `rectifyConflictedStory()` | `src/execution/merge-conflict-rectify.ts` | Direct — handles merge conflicts post-success |
| `.git/info/exclude` entries | `WorktreeManager.ensureGitExcludes()` | Direct — prevents nax runtime files from causing conflicts |
| node_modules symlink | `WorktreeManager.create()` | Direct — already symlinks from project root |

### What Changes

| Component | `"shared"` mode (default) | `"worktree"` mode |
|:----------|:--------------------------|:------------------|
| Pipeline workdir | Project root | `.nax-wt/<storyId>/` |
| Commits land on | Main branch directly | `nax/<storyId>` branch |
| Failed story commits | Stay on main | Never reach main |
| storyGitRef scope | Story-scoped within run, polluted on re-run | Always story-scoped |
| Re-run baseline | Current HEAD (includes all prior failures) | Fresh main (only merged successes) |
| Merge step | None | After pipeline passes |
| Disk usage | One copy | One copy + one worktree at a time |
| Merge conflicts | None | Possible (rare in sequential) |

### Merge Conflicts in Sequential Mode

Unlike parallel mode (where N stories run concurrently and conflict at merge), sequential worktree mode has a narrower conflict window:

```
main: A ──── A' (US-001 merged) ────────────── A'' (US-002 merge attempt)
                                    \          /
                                     nax/US-002 (branched from A, not A')
```

Conflicts occur only when:
1. US-001 passes and merges to main
2. US-002 was branched from main BEFORE US-001 merged (not possible in sequential — US-002 branches AFTER US-001 merge)

Wait — in sequential mode, US-002 branches from main **after** US-001 merges. So US-002 starts with US-001's changes. **No merge conflicts possible** in the normal sequential flow.

The conflict case is limited to:
- **Re-run after partial completion:** US-001 passed (merged), US-002 failed (branch kept). On re-run, US-002 gets a fresh branch from current main (includes US-001). No conflict.
- **Paused story resumed after other stories completed:** Same as above — fresh branch from current main.

**Merge conflicts are essentially impossible in sequential worktree mode** because each story always branches from the latest main.

### Config Schema

Add to `ExecutionConfigSchema` in `src/config/schemas.ts`:

```typescript
const ExecutionConfigSchema = z.object({
  // ... existing fields ...
  storyIsolation: z.enum(["shared", "worktree"]).default("shared"),
});
```

Add to `ExecutionConfig` in `src/config/runtime-types.ts`:

```typescript
export interface ExecutionConfig {
  // ... existing fields ...
  storyIsolation: "shared" | "worktree";
}
```

### Observability

Log the isolation mode at run start:

```typescript
logger?.info("execution", "Story isolation mode", {
  storyIsolation: config.execution.storyIsolation,
});
```

Log worktree lifecycle events:

```typescript
logger?.info("worktree", "Created worktree for story", { storyId, path: worktreePath });
logger?.info("worktree", "Merged story to main", { storyId });
logger?.info("worktree", "Kept failed story branch", { storyId, branch: `nax/${storyId}` });
logger?.info("worktree", "Cleaned up old branch for re-run", { storyId });
```

## Stories

### US-001: Add `storyIsolation` config

**Dependencies:** None

**Description:** Add `storyIsolation: "shared" | "worktree"` to `ExecutionConfigSchema` with default `"shared"`. Update `ExecutionConfig` type. Add config description.

**Acceptance Criteria:**
- `ExecutionConfigSchema` accepts `storyIsolation` with values `"shared"` and `"worktree"`, defaulting to `"shared"`
- When omitted, `NaxConfigSchema.parse({...})` produces `storyIsolation: "shared"`
- When set to `"invalid"`, `NaxConfigSchema.safeParse()` returns validation error
- `config-descriptions.ts` has entry for `execution.storyIsolation`

**Context Files:**
- `src/config/schemas.ts`
- `src/config/runtime-types.ts`
- `src/cli/config-descriptions.ts`

### US-002: Worktree lifecycle in iteration-runner

**Dependencies:** US-001

**Description:** When `storyIsolation === "worktree"`, create a worktree before pipeline execution and run the pipeline in the worktree directory. Capture `storyGitRef` inside the worktree (so it always reflects the branch point). On escalation (same story retries), reuse the existing worktree.

**Acceptance Criteria:**
- When `storyIsolation === "shared"`, `iteration-runner.ts` behaviour is unchanged (no worktree creation)
- When `storyIsolation === "worktree"`, a worktree is created at `.nax-wt/<storyId>/` before pipeline execution
- The pipeline runs with `workdir` set to the worktree path (not the project root)
- `storyGitRef` is captured inside the worktree via `captureGitRef(worktreePath)`
- When the story escalates and retries (same story, new tier), the existing worktree is reused (not recreated)
- `node_modules` is symlinked from the project root (via existing `WorktreeManager.create()`)
- `.git/info/exclude` entries are ensured before worktree creation

**Context Files:**
- `src/execution/iteration-runner.ts`
- `src/worktree/manager.ts`

### US-003: Merge on success, keep on failure

**Dependencies:** US-002

**Description:** After pipeline passes in worktree mode, merge the `nax/<storyId>` branch into main and clean up the worktree. On exhaustion failure, remove the worktree directory but keep the branch for diagnostics. Handle merge conflicts with the existing rectification flow.

**Acceptance Criteria:**
- When pipeline passes and `storyIsolation === "worktree"`, `MergeEngine.merge()` is called to merge `nax/<storyId>` into main
- On successful merge, the worktree is removed
- On merge conflict, `rectifyConflictedStory()` is called (same as parallel mode)
- If rectification fails, the story is marked as failed with reason `"merge-conflict"`
- When all tiers are exhausted, the worktree directory is removed but `nax/<storyId>` branch is kept in git
- Stories marked `"passed"` have their commits on main (merged)
- Stories marked `"failed"` have their commits on `nax/<storyId>` (not on main)

**Context Files:**
- `src/execution/pipeline-result-handler.ts`
- `src/worktree/merge.ts`
- `src/execution/merge-conflict-rectify.ts`

### US-004: Re-run cleanup for worktree mode

**Dependencies:** US-003

**Description:** On re-run, when `storyIsolation === "worktree"`, delete old `nax/<storyId>` branches for stories being reset from `"failed"` to `"pending"`. Clear `storyGitRef` so it is re-captured in the fresh worktree. Same treatment for paused stories being resumed.

**Acceptance Criteria:**
- `resetFailedStoriesToPending()` accepts a `storyIsolation` parameter
- When `storyIsolation === "worktree"`, old `nax/<storyId>` branches are deleted for reset stories
- `storyGitRef` is cleared for reset stories (set to `undefined`)
- On the next run, `worktreeManager.create()` creates a fresh worktree from current main HEAD
- Stories that were `"passed"` are NOT affected (their merged commits stay on main)
- Paused stories resumed via `paused-story-prompts.ts` follow the same cleanup when `storyIsolation === "worktree"`
- When `storyIsolation === "shared"`, the function behaves as today (no branch deletion, no storyGitRef reset)

**Context Files:**
- `src/prd/index.ts`
- `src/execution/lifecycle/run-initialization.ts`
- `src/execution/lifecycle/paused-story-prompts.ts`

### US-005: Unified executor integration

**Dependencies:** US-002, US-003

**Description:** Wire worktree lifecycle into the unified executor's sequential dispatch path. Ensure the iteration loop correctly handles worktree mode: workdir resolution, storyGitRef threading, event emission with correct workdir, and cost/metrics tracking.

**Acceptance Criteria:**
- Sequential dispatch path in `unified-executor.ts` passes worktree-aware workdir to `runIteration()`
- `story:started` events include the worktree path when in worktree mode
- `story:completed` / `story:failed` events fire after merge (not before)
- Cost tracking includes merge and rectification costs
- `statusWriter` reflects worktree-mode execution correctly
- When `storyIsolation === "shared"`, the entire sequential dispatch path is unchanged

**Context Files:**
- `src/execution/unified-executor.ts`
- `src/execution/iteration-runner.ts`
- `src/pipeline/event-bus.ts`

## Files Changed

| File | Change |
|:-----|:-------|
| `src/config/schemas.ts` | Add `storyIsolation` to `ExecutionConfigSchema` |
| `src/config/runtime-types.ts` | Add `storyIsolation` to `ExecutionConfig` |
| `src/cli/config-descriptions.ts` | Add `execution.storyIsolation` description |
| `src/execution/iteration-runner.ts` | Worktree creation, workdir resolution, storyGitRef capture |
| `src/execution/pipeline-result-handler.ts` | Merge on success, keep branch on failure |
| `src/execution/unified-executor.ts` | Wire worktree lifecycle into sequential dispatch |
| `src/prd/index.ts` | Branch cleanup in `resetFailedStoriesToPending()` |
| `src/execution/lifecycle/run-initialization.ts` | Thread storyIsolation config to reset function |
| `src/execution/lifecycle/paused-story-prompts.ts` | Branch cleanup on resume |

## What Does NOT Change

- `src/worktree/manager.ts` — reused as-is
- `src/worktree/merge.ts` — reused as-is
- `src/execution/merge-conflict-rectify.ts` — reused as-is
- Parallel execution mode — already uses worktrees, unaffected
- `storyGitRef` capture logic (BUG-114) — unchanged, just runs in worktree context
- Pipeline stages — they receive `ctx.workdir` and don't care if it's a worktree

## Risks

| Risk | Mitigation |
|:-----|:-----------|
| Disk usage: one worktree active at a time | Worktrees are lightweight (share `.git` objects). In sequential mode, only one exists at a time. Cleanup after merge or exhaustion. |
| Merge conflicts on success merge | Rare in sequential (each story branches from latest main). Existing `rectifyConflictedStory()` handles it. |
| Agent assumes project root for relative paths | Worktree symlinks `node_modules`, `.env`. Agent runs in worktree context — same as parallel mode, already validated. |
| Worktree creation overhead | `git worktree add` is fast (~100ms). One per story is negligible vs agent session time (~60-300s). |
| Story depends on prior story's code | Works correctly: prior story merged to main before next story branches. New worktree includes all merged code. |
| Crash leaves orphaned worktrees | `WorktreeManager.create()` already prunes orphaned worktrees (lines 77-84). Same crash recovery as parallel mode. |
| Default is `"shared"` — worktree users opt-in | Intentional. `"worktree"` mode changes the execution model. Users should opt-in and validate. Future default flip after production validation. |

## Relationship to Other Specs

- **SPEC-semantic-review-diff-mode.md (REVIEW-002):** The `diffMode` config (`embedded` vs `ref`) is orthogonal to `storyIsolation`. Both modes benefit from worktree isolation — the diff is always story-scoped regardless of how the reviewer accesses it. The `resetRefOnRerun` stopgap (US-005 in that spec) becomes unnecessary when `storyIsolation === "worktree"` — storyGitRef is always correct.
- **Parallel execution:** Already uses worktrees. The infrastructure is shared but the lifecycle is different (parallel creates N worktrees, sequential creates 1 at a time).

---

*Spec written 2026-04-12.*
