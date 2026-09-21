<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Feature-scoped story worktree identity

## Summary

Story worktrees are keyed on the story ID alone, so every feature in a repository competes for
the same worktree directory and the same git branch. Worktrees of one repository share a single
ref namespace, and every PRD starts at `US-001`, so two runs against one repository collide on
`nax/US-001` — one dies mid-run, and on one path the other's in-flight branch is deleted. This
feature composes a feature-scoped worktree identity (`story-<feature>-US-001`), routes every
worktree path, branch name and orphan ref through one module, and adds a static check so no site
can spell those paths itself.

## Motivation

`WorktreeManager.create` (`src/worktree/manager.ts:156-157`) builds the worktree at
`<projectRoot>/.nax-wt/<storyId>` on branch `nax/<storyId>`. The directory is per-checkout, but
the branch is not: worktrees of one repository share one ref namespace and one worktree admin
list.

With two features running against one repository, `hasWorktreeRecord`
(`src/worktree/manager.ts:94`) reads `git worktree list --porcelain`, which from a linked
worktree lists every worktree of the repository — so run B sees run A's live `nax/US-001` and
sets its cleanup evidence flag. Step 2's `remove()` targets B's own absent `.nax-wt/US-001` and
reports `WORKTREE_NOT_FOUND`, so Step 3 fires on A's in-flight branch: the `git branch -D` arm
(`src/worktree/manager.ts:235`) is refused by git for a branch checked out elsewhere, killing B
with `WORKTREE_ERROR`, while the `orphanMatchesBranch` arm (`src/worktree/manager.ts:230`) uses
`update-ref -d`, which carries no such protection.

The collision is reachable today through `execution.storyIsolation: "worktree"` and through
`--parallel`, and it becomes far more reachable once worktrees of one repository are treated as
one project.

**Partial composition is worse than none, and the surface is wider than the worktree API.**
Thirteen production sites spell a worktree path, a branch name or an orphan ref. Five reach them
through a function parameter, and eight build the string directly:

| Site | Spelling | Reached via |
|:--|:--|:--|
| `src/worktree/manager.ts:156-157`, `:323-324` | dir + branch | `create`/`remove` parameter |
| `src/worktree/merge.ts:67`, `:314` | branch, dir | `merge`/`mergeAll` parameter |
| `src/worktree/nax-orphan-ref.ts:16` | ref | `naxOrphanRefName` parameter |
| `src/execution/iteration-runner.ts:90` | dir | direct `join` |
| `src/execution/parallel-batch.ts:164` | dir | direct `join` |
| `src/execution/merge-conflict-rectify.ts:272` | dir | direct `join` |
| `src/execution/pipeline-result-handler.ts:48`, `:68` | dir | direct `join` |
| `src/execution/pipeline-result-handler.ts:116` | branch | direct interpolation |
| `src/execution/lifecycle/run-initialization.ts:239` | branch | direct interpolation in git argv |

Three of the direct sites fail silently if the parameter sites alone are composed.
`src/execution/iteration-runner.ts:90` builds the path the story actually runs in — `:99` assigns
it to `effectiveWorkdir` — so a composed `create()` beside a raw path means every sequential
worktree-mode story runs in a directory that does not exist.
`src/execution/pipeline-result-handler.ts:48` (`hasWorktree`) would return `false` for every
composed worktree, so failed-story cleanup never fires and `recordNaxOrphanOwnership` is never
called — silently disabling the BUG-28 Step-3 evidence path. And
`src/execution/pipeline-result-handler.ts:116` pairs a composed ref name with a raw
`refs/heads/nax/<storyId>` source branch, so `git update-ref` names a branch that does not exist.

## Design

Compose an opaque, feature-scoped worktree identity; give every spelling one producer; and gate
the spellings statically.

### Worktree identity

| Surface | Baseline | Target |
|:--|:--|:--|
| Worktree dir | `.nax-wt/US-001` | `.nax-wt/story-<feature>-US-001` |
| Branch | `nax/US-001` | `nax/story-<feature>-US-001` |
| Orphan ref | `refs/nax/orphan/US-001` | `refs/nax/orphan/story-<feature>-US-001` |

The natural identity is `story-<feature>-<storyId>`, sanitized to `validateStoryId`'s alphabet
and capped at 64 characters, with a distinguishing suffix when truncation would collide two
distinct inputs. `src/bakeoff/worktree-id.ts:29` already implements this derivation for bakeoff
worktrees; the shared parts move into the new module so one implementation serves both, and the
`story-` prefix keeps the two namespaces disjoint from `bakeoff-`.

Depth stays at two path segments. Two consumers parse a worktree-relative package path by
position and both assume exactly two segments: `packageOverrideKey`
(`src/runtime/packages.ts:107`, which returns `segments.slice(2).join("/")` when the first
segment is `.nax-wt`) and `storyExecRoot` (`src/runtime/packages.ts:227`, which rebuilds
`<repoRoot>/<segment0>/<segment1>`). Deepening the directory to `.nax-wt/<feature>/<storyId>`
would make both derive the wrong package key and match nothing rather than fail — the nax#2111
defect class.

### Approach — one producer per spelling, plus a static gate

A branded identity type alone is not sufficient, and the Motivation table says why: a brand
constrains a parameter, and eight of the thirteen sites build their string directly, where no
parameter type is involved. The design therefore has three parts:

1. **One producer per spelling.** `storyWorktreePath(projectRoot, worktreeId)`,
   `storyBranchName(worktreeId)` and `naxOrphanRefName(worktreeId)` are the only functions that
   spell `.nax-wt/<id>`, `nax/<id>` and `refs/nax/orphan/<id>`. Every one of the thirteen sites
   calls one of them.
2. **A branded `WorktreeId`.** A `string` carrying a unique type tag, produced only by
   `deriveStoryWorktreeId` or `deriveBakeoffWorktreeId`, and required by the worktree API and by
   the three producers. This is what stops a raw story ID being passed where an identity is
   expected. There is no existing branded type in this codebase; this introduces the pattern, in
   one module.
3. **A static gate.** `scripts/check-worktree-id-ssot.ts` fails when a literal `.nax-wt` path
   segment or a `nax/`-prefixed branch string is built outside `src/worktree/worktree-id.ts`.
   This is what makes completeness checkable rather than remembered, and it is the mechanism this
   repository already uses for exactly this class — `scripts/check-feature-dir-ssot.ts` for the
   feature tree, `scripts/check-no-real-global-nax.ts` for `~/.nax`, and
   `scripts/check-permission-mode-ssot.ts` for permission literals. Like those, it takes a
   comment escape hatch for genuine prose, and it is reachable from `check:all-without-biome`.

Adding a `feature: string` parameter to the worktree API instead was rejected:
`src/bakeoff/contestant.ts:143` already passes an **already-composed** identity
(`deriveBakeoffWorktreeId(feature, agent)`, at `src/bakeoff/contestant.ts:101`) into the same
`create()`, so composing inside from a `feature` parameter would compose bakeoff's identity a
second time.

### What keeps the raw story ID

The composed identity names a worktree. It is never the story's identity. Two shapes in
particular keep the raw `story.id`, because they are join keys:

- `MergeResult.storyId` (`src/worktree/merge.ts:21-23`, populated at `:170`, `:187`, `:214`) is
  matched against `workerResult.pipelinePassed.find((s) => s.id === mergeResult.storyId)` at
  `src/execution/parallel-batch.ts:286`, guarded by `if (!story) continue`, and is the key for
  `workerResult.storyCosts.get(...)` at `:310` and for
  `prd.userStories.find((s) => s.id === storyId)` at
  `src/execution/merge-conflict-rectify.ts:288`. If it carried the worktree identity, every
  successfully merged story would be silently dropped from `completed`.
- `StoryDependencies` (`src/worktree/merge.ts:32-34`), the third parameter of `mergeAll`, is
  keyed by raw story IDs — built as `deps[s.id] = s.dependencies ?? []` at
  `src/execution/parallel-batch.ts:280-281` and read at `src/worktree/merge.ts:181`. It stays
  keyed by raw story IDs, so `mergeAll` receives both a per-story identity and the raw
  dependency map.

Metrics, costs, status and logs likewise keep the raw story ID.

### Integration

Read-only symbols, verified present at their stated shapes:

- `validateStoryId(storyId: string): void` — `src/prd/validate.ts`, imported at
  `src/worktree/manager.ts:6`; rejects traversal, git-flag shapes, and characters outside
  `[a-zA-Z0-9._-]`.
- `_worktreeManagerDeps.gitWithTimeout(args, cwd)` — `src/worktree/manager.ts:19`.
- `_iterationRunnerDeps.existsSync` — `src/execution/iteration-runner.ts:325`; the guard that
  decides whether a story's worktree is created or reused.
- `_parallelBatchDeps.createWorktreeManager` — `src/execution/parallel-batch.ts:100`.
- `_resultHandlerDeps.spawn` — `src/execution/pipeline-result-handler.ts`; the git seam the
  orphan-ref writer uses.
- `packageOverrideKey(packageDir: string): string` — `src/runtime/packages.ts:107`.
- `storyExecRoot(view): string` — `src/runtime/packages.ts:227`.
- The run's feature name is available at every call site: `options.prd.feature`
  (`src/execution/parallel-batch.ts:122`), `ctx.feature`
  (`src/execution/iteration-runner.ts:267`, `src/execution/pipeline-result-handler.ts:209`) and
  `prd.feature` (`src/execution/merge-conflict-rectify.ts:281`,
  `src/execution/lifecycle/run-initialization.ts:208`). `PipelineContext` has no plain `feature`
  field, so sites reading a PRD use `prd.feature`.

Mutated symbols. The baseline exists to locate the code; the target is the interface to
implement.

**`deriveBakeoffWorktreeId`** — `src/bakeoff/worktree-id.ts:29`

- Baseline: `deriveBakeoffWorktreeId(feature: string, profile: string): string`.
- Target: returns `WorktreeId`. Its composition inputs, its `bakeoff-` prefix and its call site
  are unchanged; only the return type narrows, so `src/bakeoff/contestant.ts:143` keeps
  typechecking against the branded `create`.

**`ContestantRunnerDeps.worktreeManager`** — `src/bakeoff/contestant.ts:62-66`

- Baseline: a structural type declaring `create`/`remove` as
  `(projectRoot: string, storyId: string) => Promise<unknown>`.
- Target: both take `WorktreeId`, so this second declaration of the signature cannot drift from
  the class it stands in for.

**`WorktreeManager.create`** — `src/worktree/manager.ts:153`

- Baseline: `create(projectRoot: string, storyId: string): Promise<void>`, deriving
  `join(projectRoot, ".nax-wt", storyId)` and `` `nax/${storyId}` `` at `:156-157`.
- Target: `create(projectRoot: string, worktreeId: WorktreeId): Promise<void>`, taking the
  directory from `storyWorktreePath` and the branch from `storyBranchName`.

**`WorktreeManager.remove`** — `src/worktree/manager.ts:320`

- Baseline: `remove(projectRoot: string, storyId: string)`, repeating the same two derivations at
  `:323-324`.
- Target: `remove(projectRoot: string, worktreeId: WorktreeId)`, through the same two producers.

**`MergeEngine.merge`** — `src/worktree/merge.ts:66`

- Baseline: `merge(projectRoot: string, storyId: string)`, interpolating
  `` const branchName = `nax/${storyId}` `` at `:67`.
- Target: `merge(projectRoot: string, worktreeId: WorktreeId)`, taking the branch from
  `storyBranchName`. The returned `MergeResult.storyId` is unchanged and still carries the raw
  story ID.

**`MergeEngine.mergeAll`** — `src/worktree/merge.ts:157`

- Baseline: `mergeAll(projectRoot: string, storyIds: string[], dependencies: StoryDependencies)`,
  sorting by `topologicalSort(storyIds, dependencies)` at `:165` and reading
  `dependencies[storyId]` at `:181`.
- Target: takes each story's raw ID paired with its `WorktreeId`, keeps `dependencies` keyed by
  raw story IDs so the sort and the failed-dependency skip still resolve, and keeps
  `MergeResult.storyId` raw.

**`naxOrphanRefName`** — `src/worktree/nax-orphan-ref.ts:15`

- Baseline: `naxOrphanRefName(storyId: string): string` returning `refs/nax/orphan/<storyId>`.
- Target: `naxOrphanRefName(worktreeId: WorktreeId): string` returning
  `refs/nax/orphan/<worktreeId>`, so the ref the writer records and the ref the reader looks up
  cannot diverge.

### Failure Handling

| Condition | Behavior |
|:--|:--|
| Feature name or story ID contains characters outside `validateStoryId`'s alphabet | Sanitized during derivation; the resulting identity is always accepted by `validateStoryId`. |
| Natural identity exceeds 64 characters | Truncated with a distinguishing suffix; the truncated identity is still accepted by `validateStoryId`, and two distinct inputs never produce one identity. |
| `git worktree add` fails because the composed branch already exists | Unchanged `WORKTREE_ERROR` (`src/worktree/manager.ts:264`), naming the composed branch. |
| A branch from before this change (`nax/<storyId>`) is present | Not recognised as this feature's orphan and left untouched; it is neither reused nor deleted. |

## Out of Scope

- Legacy `nax/<storyId>` branches created before this feature are not detected, reused or
  deleted, and must be removed manually with `git branch -D`; an automatic sweep would have to
  force-delete a branch a pre-upgrade run in another checkout may still hold.
- Changing the `.nax-wt/<id>` worktree directory to more than two path segments is not part of
  this feature.
- Changing bakeoff's composition inputs or its `bakeoff-` prefix is not part of this feature;
  only `deriveBakeoffWorktreeId`'s return type narrows.
- Two concurrent runs of the **same** feature against one repository still collide on
  `nax/story-<feature>-US-001`; serializing them is the feature lock delivered by the
  `project-identity-run-locking` feature, not this one.
- Matching project identity by git remote, and the `RUN_NAME_COLLISION` behaviour of
  `claimProjectIdentity`, are delivered by the `project-identity-run-locking` feature.
- Run locking of any kind is delivered by the `project-identity-run-locking` feature.
- Introducing branded types anywhere outside the worktree identity is not part of this feature.
- An empty feature name yields the identity `story--<storyId>` and is accepted; rejecting it is
  not part of this feature, because `src/bakeoff/contestant.ts:100` already tolerates an empty
  feature through `options.feature ?? ""`.

## Stories

**US-001 — The identity module and its static gate**
Create the branded `WorktreeId`, `deriveStoryWorktreeId`, `storyWorktreePath` and
`storyBranchName` in one module, moving the shared sanitize, cap and hash-suffix derivation out
of `src/bakeoff/worktree-id.ts`, and add the static check that fails when any other file spells a
`.nax-wt` path or a `nax/` branch. No dependencies.

**US-002 — The worktree API takes the identity**
Change `WorktreeManager.create`/`remove`, `MergeEngine.merge`/`mergeAll` and `naxOrphanRefName`
to accept `WorktreeId` and to take every spelling from US-001's producers, keeping
`MergeResult.storyId` and the `StoryDependencies` map keyed by raw story IDs. Depends on US-001.

**US-003 — Every execution-layer site derives the identity**
Update the eight sites outside `src/worktree/` that build a worktree path or branch string from a
raw story ID, so each derives an identity from its run's feature, while metrics, costs and status
keep the raw story ID. Depends on US-002.

### Context Files

**US-001**

- `src/bakeoff/worktree-id.ts` — the sanitize, cap and hash-suffix derivation to move
- `src/bakeoff/contestant.ts` — the second declaration of the worktree-manager signature, and the already-composed bakeoff identity
- `src/prd/validate.ts` — the alphabet the derivation sanitizes to
- `scripts/check-feature-dir-ssot.ts` — the static-gate pattern to follow, including its comment escape hatch
- `scripts/check-no-real-global-nax.ts` — a second gate of the same shape, for the allowlist style

**US-002**

- `src/worktree/manager.ts` — worktree and branch construction, and the three-step cleanup
- `src/worktree/merge.ts` — the branch interpolation, the dependency map and `MergeResult`
- `src/worktree/nax-orphan-ref.ts` — the existing one-helper-per-ref-name precedent
- `src/worktree/worktree-id.ts` — created by US-001, consumed here

**US-003**

- `src/execution/parallel-batch.ts` — creates, removes and maps story worktrees
- `src/execution/iteration-runner.ts` — the sequential `storyIsolation: "worktree"` path
- `src/execution/merge-conflict-rectify.ts` — removes and recreates a worktree during rectification
- `src/execution/pipeline-result-handler.ts` — merges, removes, and writes the orphan ref
- `src/execution/lifecycle/run-initialization.ts` — deletes stale branches before creation

### Creates

**US-001**

- `src/worktree/worktree-id.ts` — the branded identity, the story derivation, and the path and branch producers
- `scripts/check-worktree-id-ssot.ts` — the static gate over `.nax-wt` and `nax/` spellings

### Modifies

**US-001**

- `src/bakeoff/worktree-id.ts` — its sanitize, cap and hash-suffix helpers move into the new module and it re-exports or delegates; its own tests pin the returned strings, which do not change.

**US-002**

- `test/integration/worktree/manager.test.ts` — calls `manager.create` and `manager.remove` with a raw string story ID, which the branded parameter no longer accepts; the calls must derive an identity and the branch and directory assertions must read the derived value.
- `test/integration/worktree/worktree-merge.test.ts` — asserts the merge commit message and post-cleanup branch absence against a branch name built from a raw story ID; both must be derived through `storyBranchName`.
- `test/unit/worktree/manager.test.ts` — passes raw string story IDs into `manager.create`, `manager.remove` and `naxOrphanRefName` at twelve call sites, which the branded parameters no longer accept; each must derive an identity.
- `test/unit/worktree/nax-orphan-ref.test.ts` — calls `naxOrphanRefName` with raw string story IDs at six sites and asserts the returned ref; each must pass a derived identity and assert the composed ref.
- `test/unit/execution/merge.test.ts` — passes raw string story IDs into `engine.merge` and `engine.mergeAll` at ten sites, which the branded parameters no longer accept; each must pass a derived identity while the dependency map stays keyed by raw story IDs.
- `test/integration/bakeoff/coordinator-worktree-isolation.test.ts` — its worktree-manager adapter declares `storyId: string`, which no longer satisfies the branded parameter; the adapter must take `WorktreeId`.
- `test/integration/bakeoff/preflight-reclaim.test.ts` — calls `manager.create` and `manager.remove` with a raw string identifier; both must pass a derived identity.

**US-003**

- `test/unit/execution/pipeline-result-handler-worktree-cleanup.test.ts` — pins the worktree directory and branch for story `US-001` at their raw spellings; both must read the composed spellings.
- `test/unit/execution/merge-conflict-rectify.test.ts` — pins the rectification worktree directory at its raw spelling; it must read the composed spelling.
- `test/unit/execution/parallel-batch.test.ts` — pins the mapped worktree path at its raw spelling; it must read the composed spelling.

### Seams

- `[unit]` set `_parallelBatchDeps.createWorktreeManager` to a recording double; run `runParallelBatch` over one story under feature `f`; assert the double's `create` received `story-f-US-001`.
- `[unit]` set `_iterationRunnerDeps.worktreeManager` to a recording double and `_iterationRunnerDeps.existsSync` to report the worktree absent; run the iteration runner for one story under feature `f` with `execution.storyIsolation` set to `worktree`; assert the double's `create` received `story-f-US-001`.
- `[unit]` set `_resultHandlerDeps.spawn` to a recording double; drive the result handler's orphan-ref path for story `US-001` under feature `f`; assert the recorded git arguments name both the composed ref and the composed source branch.

## Acceptance Criteria

### US-001 — The identity module and its static gate

- `[unit]` `deriveStoryWorktreeId("my-feature", "US-001")` returns `story-my-feature-US-001`.
- `[unit]` `deriveStoryWorktreeId` returns an identity accepted by `validateStoryId` when the feature name contains characters outside `[a-zA-Z0-9._-]`.
- `[unit]` `deriveStoryWorktreeId` returns an identity of at most 64 characters when the natural `story-<feature>-<storyId>` form is longer.
- `[unit]` an identity produced by the truncating path is accepted by `validateStoryId`.
- `[unit]` two distinct feature-and-story pairs whose natural identities share their first 64 characters produce different results from `deriveStoryWorktreeId`.
- `[unit]` `deriveStoryWorktreeId` returns an identity beginning with `story-`.
- `[unit]` `deriveBakeoffWorktreeId` returns an identity beginning with `bakeoff-`, unchanged in value from before this feature for the same inputs.
- `[unit]` `storyWorktreePath("/repo", "story-f-US-001")` returns the path `/repo/.nax-wt/story-f-US-001`.
- `[unit]` `storyBranchName("story-f-US-001")` returns `nax/story-f-US-001`.
- `[cli]` the static check exits non-zero when a source file outside the identity module builds a string containing a `.nax-wt` path segment.
- `[cli]` the static check exits non-zero when a source file outside the identity module builds a branch string prefixed `nax/`.
- `[cli]` the static check exits zero for a file carrying the documented allow comment on that line.
- `[cli]` the static check exits zero against the repository once every site derives its spellings.

### US-002 — The worktree API takes the identity

- `[integration]` `WorktreeManager.create` given the identity derived for feature `f` and story `US-001` creates a worktree directory ending in `.nax-wt/story-f-US-001`.
- `[integration]` `WorktreeManager.create` given that identity creates a branch named `nax/story-f-US-001`.
- `[integration]` `WorktreeManager.remove` given that identity removes the `nax/story-f-US-001` branch.
- `[unit]` `naxOrphanRefName` given that identity returns `refs/nax/orphan/story-f-US-001`.
- `[unit]` `MergeEngine.merge` given that identity invokes git with the branch name `nax/story-f-US-001`.
- `[unit]` the `MergeResult` returned by `MergeEngine.merge` for story `US-001` carries `storyId` equal to `US-001`.
- `[unit]` `MergeEngine.mergeAll` orders two stories by a dependency map keyed by their raw story IDs, merging the dependency before the dependent.
- `[unit]` `MergeEngine.mergeAll` skips a story whose raw-ID dependency failed, reporting it unmerged.
- `[unit]` `WorktreeManager.create` reports `WORKTREE_ERROR` naming `nax/story-f-US-001` when that branch already exists.
- `[integration]` in a repository with a linked git worktree, creating a story worktree for `US-001` under feature `a` from the main checkout and then for `US-001` under feature `b` from the linked worktree both resolve without error.
- `[integration]` after the linked worktree creates its `US-001` worktree for feature `b`, the branch `nax/story-a-US-001` created from the main checkout still exists.

### US-003 — Every execution-layer site derives the identity

- `[unit]` `runParallelBatch` for story `US-001` under feature `f` calls `WorktreeManager.create` with the identity `story-f-US-001`.
- `[unit]` `runParallelBatch` maps that story's worktree path to one ending in `.nax-wt/story-f-US-001`.
- `[unit]` a story merged by `runParallelBatch` under feature `f` appears in the returned `completed` list, keyed by its raw story ID.
- `[unit]` after `runParallelBatch` completes for story `US-001`, the returned `storyCosts` map is keyed by `US-001`.
- `[unit]` the iteration runner, for a story whose worktree directory does not yet exist under `execution.storyIsolation` set to `worktree`, calls `WorktreeManager.create` with the identity `story-f-US-001`.
- `[unit]` the iteration runner runs that story with its working directory set to the path ending in `.nax-wt/story-f-US-001`.
- `[unit]` merge-conflict rectification for story `US-001` under feature `f` calls `WorktreeManager.create` with the identity `story-f-US-001` and uses the matching worktree directory.
- `[unit]` the result handler's worktree-existence check for story `US-001` under feature `f` tests the path ending in `.nax-wt/story-f-US-001`.
- `[unit]` the result handler removes the worktree directory ending in `.nax-wt/story-f-US-001` for that story.
- `[unit]` the result handler's orphan-ref write for story `US-001` under feature `f` names the ref `refs/nax/orphan/story-f-US-001` and the source branch `refs/heads/nax/story-f-US-001`.
- `[unit]` the result handler merges story `US-001` under feature `f` by calling `MergeEngine.merge` with the identity `story-f-US-001`.
- `[unit]` run initialization, for a story reset from failed to pending under `execution.storyIsolation` set to `worktree`, deletes the branch `nax/story-f-US-001`.
- `[unit]` the story metrics recorded for story `US-001` carry `storyId` equal to `US-001`.
- `[unit]` `packageOverrideKey` applied to `.nax-wt/story-f-US-001/packages/core` returns `packages/core`.
- `[unit]` `storyExecRoot` applied to a repo root with package directory `.nax-wt/story-f-US-001/packages/core` returns the path ending in `.nax-wt/story-f-US-001`.
