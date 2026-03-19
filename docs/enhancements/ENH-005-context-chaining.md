# ENH-005: Context chaining — feed parent story outputs to dependent stories

**Type:** Enhancement  
**Component:** `src/execution/`, `src/context/builder.ts`, `src/prd/types.ts`  
**Filed:** 2026-03-19  
**Status:** Done  
**Source:** Post-mortem koda/fix/refactor-standard (ENH-002)

---

## Problem

Story dependencies (`"dependencies": ["US-001"]`) only control execution order. The dependent story receives no context about what the parent story actually produced.

**Koda run example:**
- US-001 produced `MIGRATION_PLAN.md` (797 lines of analysis)
- US-002 depends on US-001 but never received this file
- All sessions logged: `scopeToStory=true but no contextFiles provided — falling back to full scan`
- US-002 started from scratch, ignoring US-001's work

---

## Design: Post-Completion Snapshot (Option C)

After a story passes, capture which files it changed via git diff and store them on the story. Dependent stories automatically receive these files as additional context.

### Why Option C

- **Accurate** — based on actual changes, not LLM predictions
- **Zero config** — no `outputFiles` field to maintain in PRD
- **Leverages existing plumbing** — `storyGitRef` already captured, `contextFiles` already injected

---

## Execution Paths & Git Ref Handling

nax has two execution paths with different git behaviors:

### Sequential path (`iteration-runner.ts`)

```
storyGitRef = captureGitRef(workdir)   ← HEAD before story
  → execution stage (agent writes code)
  → autoCommitIfDirty()                ← commits uncommitted changes
  → review / autofix stages
  → handlePipelineSuccess()            ← story passes
  → capture outputFiles here
```

**`storyGitRef` is correct** — it captures HEAD before the story starts.  
`git diff storyGitRef..HEAD` includes agent commits + auto-commits.

**Monorepo concern:** In sequential execution, stories share the same working directory. If US-001 touched `apps/api/` and US-002 touched `apps/web/`, then `git diff US002-ref..HEAD` includes US-002's files but ALSO any commits from stories that ran between `storyGitRef` capture and HEAD.

**Fix:** Scope the diff to `story.workdir` when set:
```bash
git diff <storyGitRef>..HEAD --name-only -- apps/api/
```

### Parallel path (`parallel-worker.ts` → `parallel-coordinator.ts`)

Parallel stories run in **separate git worktrees** (`.nax-wt/<storyId>/`), then get merged back.

- No `storyGitRef` per story (not captured in parallel-worker)
- After merge, changes are on the main branch

**Parallel capture approach:** After successful merge in `parallel-coordinator.ts`, diff the merge commit:
```typescript
// After markStoryPassed in parallel-coordinator.ts
const mergeCommit = await getHeadRef(projectRoot);
const parentCommit = await getParentRef(projectRoot, mergeCommit);
const outputFiles = await getChangedFiles(projectRoot, parentCommit, story.workdir);
story.outputFiles = outputFiles;
```

Or simpler: diff the worktree's HEAD against its base before merging:
```typescript
// In parallel-coordinator.ts, before merge
const worktreeBase = await getBaseRef(worktreePath);  // ref when worktree was created
const outputFiles = await getChangedFiles(worktreePath, worktreeBase, story.workdir);
```

**Recommended:** Capture in parallel-worker return value (add `changedFiles: string[]` to result), then store on story after merge. This avoids timing issues with the merge commit.

---

## Implementation

### Part A: Capture `outputFiles` after story passes

#### A1: Add field to `UserStory`

```typescript
// src/prd/types.ts
interface UserStory {
  // ... existing fields ...
  /** Files created/modified by this story (auto-captured after completion) */
  outputFiles?: string[];
}
```

#### A2: New helper — `captureOutputFiles`

```typescript
// src/utils/git.ts
export async function captureOutputFiles(
  workdir: string,
  baseRef: string,
  scopePrefix?: string,  // story.workdir for monorepo scoping
): Promise<string[]> {
  const args = ["diff", "--name-only", `${baseRef}..HEAD`];
  if (scopePrefix) args.push("--", `${scopePrefix}/`);
  
  const proc = Bun.spawn(["git", ...args], { cwd: workdir });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  
  return output.trim().split("\n").filter(Boolean);
}
```

#### A3: Sequential path — capture in `handlePipelineSuccess`

```typescript
// src/execution/pipeline-result-handler.ts — handlePipelineSuccess()

// After marking stories complete, capture output files
if (ctx.storyGitRef) {
  for (const completedStory of ctx.storiesToExecute) {
    try {
      const outputFiles = await captureOutputFiles(
        ctx.workdir,
        ctx.storyGitRef,
        completedStory.workdir,  // monorepo scoping
      );
      // Filter out noise: test files, lock files, nax runtime files
      completedStory.outputFiles = filterOutputFiles(outputFiles);
    } catch {
      // Non-fatal — context chaining is best-effort
      logger?.debug("context-chain", "Failed to capture output files", {
        storyId: completedStory.id,
      });
    }
  }
}
```

#### A4: Parallel path — capture in worker, store after merge

```typescript
// src/execution/parallel-worker.ts — executeStoryInWorktree()
// Capture changed files before returning result
if (result.success) {
  const changedFiles = await captureOutputFiles(worktreePath, "HEAD~1", story.workdir);
  return { success: true, cost: result.cost, changedFiles };
}

// src/execution/parallel-coordinator.ts — after merge
if (mergeResult.success) {
  markStoryPassed(currentPrd, mergeResult.storyId);
  const mergedStory = batchResult.pipelinePassed.find(s => s.id === mergeResult.storyId);
  if (mergedStory) {
    // Retrieve changedFiles from worker result
    mergedStory.outputFiles = filterOutputFiles(workerChangedFiles.get(mergeResult.storyId) ?? []);
  }
}
```

### Part B: Inject parent output files into dependent stories

#### B1: New helper — `getParentOutputFiles`

```typescript
// src/context/parent-context.ts (new file)

const MAX_PARENT_FILES = 10;
const NOISE_PATTERNS = [
  /\.test\.(ts|js|tsx|jsx)$/,
  /\.spec\.(ts|js|tsx|jsx)$/,
  /package-lock\.json$/,
  /bun\.lock$/,
  /\.gitignore$/,
  /nax\//,  // nax runtime files
];

export function getParentOutputFiles(story: UserStory, allStories: UserStory[]): string[] {
  if (!story.dependencies || story.dependencies.length === 0) return [];

  const parentFiles: string[] = [];
  
  // Direct parents only — no transitive deps (keep simple, extend later)
  for (const depId of story.dependencies) {
    const parent = allStories.find(s => s.id === depId);
    if (parent?.outputFiles) {
      parentFiles.push(...parent.outputFiles);
    }
  }

  // Dedupe, filter noise, cap at limit
  const unique = [...new Set(parentFiles)];
  const filtered = unique.filter(f => !NOISE_PATTERNS.some(p => p.test(f)));
  return filtered.slice(0, MAX_PARENT_FILES);
}
```

#### B2: Merge into context builder

```typescript
// src/context/builder.ts — addFileElements()

// Before auto-detect, inject parent output files
const parentFiles = getParentOutputFiles(story, storyContext.allStories ?? []);
if (parentFiles.length > 0) {
  const logger = getLogger();
  logger.info("context", "Injecting parent output files", {
    storyId: story.id,
    parentFiles,
  });
  // Merge with existing contextFiles (don't replace)
  contextFiles = [...new Set([...contextFiles, ...parentFiles])];
}
```

#### B3: Thread `allStories` into StoryContext

```typescript
// src/context/types.ts — StoryContext
interface StoryContext {
  // ... existing fields ...
  allStories?: UserStory[];  // for parent output file resolution
}
```

Set in `iteration-runner.ts` and `parallel-worker.ts` when building the pipeline context.

---

## Files to Change

| # | File | Change | Lines |
|:--|:-----|:-------|:------|
| 1 | `src/prd/types.ts` | Add `outputFiles?: string[]` to `UserStory` | +2 |
| 2 | `src/utils/git.ts` | Add `captureOutputFiles()` helper | +15 |
| 3 | `src/execution/pipeline-result-handler.ts` | Capture `outputFiles` in `handlePipelineSuccess` | +15 |
| 4 | `src/execution/parallel-worker.ts` | Return `changedFiles` in result | +8 |
| 5 | `src/execution/parallel-coordinator.ts` | Store `outputFiles` on story after merge | +8 |
| 6 | `src/context/parent-context.ts` | **New file** — `getParentOutputFiles()` + `filterOutputFiles()` | +40 |
| 7 | `src/context/builder.ts` | Inject parent files before auto-detect | +10 |
| 8 | `src/context/types.ts` | Add `allStories` to `StoryContext` | +2 |
| 9 | `test/unit/context/parent-context.test.ts` | **New file** — test parent file resolution | +100 |
| 10 | `test/unit/execution/pipeline-result-handler.test.ts` | Test outputFiles capture | +40 |

**Total: 8 files modified, 2 new files, ~240 lines**

---

## Monorepo Scoping Summary

| Scenario | Diff command | Result |
|:---------|:-------------|:-------|
| Non-monorepo story | `git diff ref..HEAD --name-only` | All changed files |
| Monorepo, `workdir: "apps/api"` | `git diff ref..HEAD --name-only -- apps/api/` | Only `apps/api/` files |
| Parallel worktree | Diff worktree HEAD vs base ref | Isolated per worktree |
| No `storyGitRef` (edge case) | Skip capture | No `outputFiles` — dependent story uses auto-detect fallback |

---

## Auto-Commit Handling

`autoCommitIfDirty()` runs in the execution stage AFTER the agent finishes but BEFORE `storyGitRef..HEAD` is diffed. This means:

- ✅ Agent commits are included
- ✅ Auto-committed leftover changes are included
- ✅ Review/autofix stage changes are included (they happen after execution)

No special handling needed — the timing is already correct.

---

## Edge Cases

| Case | Behavior |
|:-----|:---------|
| Story has no dependencies | No parent files injected — existing behavior unchanged |
| Parent story failed (no `outputFiles`) | Dependent story gets no parent context — falls back to auto-detect |
| Parent produced 50+ files | Capped at 10 after filtering noise |
| Parent's files outside `story.workdir` | Still injected — the dependent may need cross-package context from parent |
| Transitive deps (US-003 → US-002 → US-001) | Only US-002's `outputFiles`, not US-001's. Extend later if needed. |
| Story already has `contextFiles` in PRD | Parent files merged (appended + deduped), not replaced |
| `git diff` fails | Non-fatal — logged at debug, no `outputFiles` stored |
| Parallel: merge conflict | `outputFiles` not stored (story marked failed) |

---

## Test Plan

### `parent-context.test.ts` (new)

| Test | Input | Expected |
|:-----|:------|:---------|
| Direct parent with outputFiles | US-002 depends on US-001, US-001 has `outputFiles` | Returns US-001's files |
| No dependencies | US-001 with empty `dependencies` | Returns `[]` |
| Parent has no outputFiles | US-002 depends on US-001, US-001 has no `outputFiles` | Returns `[]` |
| Filters test files | Parent output includes `foo.test.ts` | Filtered out |
| Filters lock files | Parent output includes `bun.lock` | Filtered out |
| Caps at 10 files | Parent produced 20 files | Returns first 10 after filtering |
| Multiple parents | US-003 depends on [US-001, US-002] | Merged + deduped |
| No transitive | US-003 → US-002 → US-001 | Only US-002's files |

### `pipeline-result-handler.test.ts` additions

| Test | Input | Expected |
|:-----|:------|:---------|
| Captures outputFiles on success | Story passes with storyGitRef | `story.outputFiles` populated |
| Scopes to workdir | `story.workdir = "apps/api"` | Only `apps/api/` files captured |
| No storyGitRef | `storyGitRef = undefined` | `outputFiles` not set |
| Git diff error | Mock git failure | Non-fatal, no `outputFiles` |

---

## Acceptance Criteria

- [ ] Passed stories store `outputFiles` in prd.json (sequential path)
- [ ] Passed stories store `outputFiles` in prd.json (parallel path)
- [ ] Monorepo: `outputFiles` scoped to `story.workdir` via `git diff -- <path>`
- [ ] Auto-commits included in `outputFiles` (correct by timing)
- [ ] Dependent stories receive parent `outputFiles` as additional context
- [ ] Parent files merged with (not replacing) existing `contextFiles`
- [ ] Test/lock/nax files filtered from `outputFiles`
- [ ] Capped at 10 parent files per story
- [ ] No transitive dependency resolution (direct parents only)
- [ ] Non-fatal: git diff failure doesn't break the run
- [ ] All 12 test cases pass
