<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Feature-scoped story worktree identity

## Summary

Story worktrees are keyed on the story ID alone, so every feature in a repository competes for
the same worktree directory and the same git branch. Worktrees of one repository share a single
ref namespace, and every PRD starts at `US-001`, so two runs against one repository collide on
`nax/US-001` — one dies mid-run, and on one path the other's in-flight branch is deleted. This
feature composes a feature-scoped worktree identity (`story-<feature>-US-001`) and routes every
worktree, merge and orphan-ref call through it, enforced by the type system so no call site can
pass a raw story ID.

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
with `WORKTREE_ERROR`, while the `orphanMatchesBranch` arm
(`src/worktree/manager.ts:230`) uses `update-ref -d`, which carries no such protection.

The collision is reachable today through `execution.storyIsolation: "worktree"` and through
`--parallel`, and it becomes far more reachable once worktrees of one repository are treated as
one project. This feature is the prerequisite for that change.

The identity must reach six production sites, not one. `src/execution/parallel-batch.ts:145`,
`src/worktree/merge.ts:90`, `src/execution/iteration-runner.ts:95`,
`src/execution/merge-conflict-rectify.ts:271`, `src/execution/pipeline-result-handler.ts:290`
and `src/execution/lifecycle/run-initialization.ts:234` each construct a worktree, a branch or
an orphan ref from a raw story ID. Composing at some of them and not others is worse than
composing at none: `src/execution/pipeline-result-handler.ts:290` merges the raw `story.id`, so
a worktree created under a composed name would be merged by a call naming a branch that does
not exist, and the orphan ref written at `src/execution/pipeline-result-handler.ts:115` would
be recorded under one spelling and looked up under another — silently disabling the BUG-28
Step-3 evidence path that ref exists to provide.

## Design

Compose an opaque, feature-scoped worktree identity and make the type system require it.

### Worktree identity

| Surface | Baseline | Target |
|:--|:--|:--|
| Worktree dir | `.nax-wt/US-001` | `.nax-wt/story-<feature>-US-001` |
| Branch | `nax/US-001` | `nax/story-<feature>-US-001` |
| Orphan ref | `refs/nax/orphan/US-001` | `refs/nax/orphan/story-<feature>-US-001` |

The natural identity is `story-<feature>-<storyId>`, sanitized to `validateStoryId`'s alphabet
and capped at 64 characters, with a distinguishing suffix when truncation would collide two
distinct inputs. `src/bakeoff/worktree-id.ts:29` already implements exactly this derivation for
bakeoff worktrees; the shared parts are extracted so one implementation serves both, and the
`story-` prefix keeps the two namespaces disjoint from `bakeoff-`.

Depth stays at two path segments. Two consumers parse a worktree-relative package path by
position and both assume exactly two segments: `packageOverrideKey`
(`src/runtime/packages.ts:107`, which returns `segments.slice(2).join("/")` when the first
segment is `.nax-wt`) and `storyExecRoot` (`src/runtime/packages.ts:227`, which rebuilds
`<repoRoot>/<segment0>/<segment1>`). Deepening the directory to `.nax-wt/<feature>/<storyId>`
would make both derive the wrong package key and match nothing rather than fail — the nax#2111
defect class.

### Approach — a branded type, not a feature parameter

The identity must be composed exactly once per site, at every site. Two shapes were considered:

Adding a `feature: string` parameter to the worktree API was rejected: `src/bakeoff/contestant.ts:143`
already passes an **already-composed** identity (`deriveBakeoffWorktreeId(feature, agent)`, at
`src/bakeoff/contestant.ts:101`) into the same `create()`, so composing inside from a `feature`
parameter would compose bakeoff's identity a second time.

Composing at each call site was rejected because nothing enforces completeness: both identities
are `string`, so a site that passes a raw story ID compiles, and the two namespaces then mix in
the way described in Motivation.

The API therefore takes a **branded** identity type — `WorktreeId`, a `string` carrying a unique
type tag — produced only by `deriveStoryWorktreeId` or `deriveBakeoffWorktreeId`. A raw story ID
is a `string` and is not assignable to it, so every call site must route through a derivation and
the compiler enumerates the ones that do not. There is no existing branded type in this codebase;
this introduces the pattern, in one module, because it is the only shape that makes the
completeness requirement checkable rather than remembered.

### Integration

Read-only symbols, verified present at their stated shapes:

- `deriveBakeoffWorktreeId(feature: string, profile: string): string` —
  `src/bakeoff/worktree-id.ts:29`; sanitizes to `validateStoryId`'s alphabet, caps at 64
  characters, appends a hash suffix when truncation could collide two distinct inputs.
- `validateStoryId(storyId: string): void` — `src/prd/validate.ts`, imported at
  `src/worktree/manager.ts:6`; rejects traversal, git-flag shapes, and characters outside
  `[a-zA-Z0-9._-]`.
- `_worktreeManagerDeps.gitWithTimeout(args, cwd)` — `src/worktree/manager.ts:19`; the injectable
  git seam the integration tests drive against real repositories.
- `_gitDeps.spawn` — `src/utils/git.ts:41`; the seam under `gitWithTimeout`, used to assert git
  argv without `mock.module`.
- `packageOverrideKey(packageDir: string): string` — `src/runtime/packages.ts:107`.
- `storyExecRoot(view): string` — `src/runtime/packages.ts:227`.

Mutated symbols. The baseline exists to locate the code; the target is the interface to
implement.

**`WorktreeManager.create`** — `src/worktree/manager.ts:153`

- Baseline: `create(projectRoot: string, storyId: string): Promise<void>`, deriving
  `join(projectRoot, ".nax-wt", storyId)` and `` `nax/${storyId}` `` at `:156-157`.
- Target: `create(projectRoot: string, worktreeId: WorktreeId): Promise<void>`. The derivations
  read the branded identity; the branch name comes from `storyBranchName`.

**`WorktreeManager.remove`** — `src/worktree/manager.ts:321`

- Baseline: `remove(projectRoot: string, storyId: string)`, repeating the same two derivations
  at `:323-324`.
- Target: `remove(projectRoot: string, worktreeId: WorktreeId)`, deriving through the same
  helpers as `create`.

**`MergeEngine.merge`** — `src/worktree/merge.ts:66`

- Baseline: `merge(projectRoot: string, storyId: string)`, interpolating
  `` const branchName = `nax/${storyId}` `` at `:67`.
- Target: `merge(projectRoot: string, worktreeId: WorktreeId)`, taking the branch name from
  `storyBranchName`.

**`MergeEngine.mergeAll`** — `src/worktree/merge.ts`

- Baseline: takes a story-ID list and a per-story file map, and calls `remove` at `:90` and
  `rebaseWorktree` (which builds `` `${projectRoot}/.nax-wt/${storyId}` `` at `:314`).
- Target: takes `WorktreeId` values in place of story IDs, so every path beneath it is branded.

**`naxOrphanRefName`** — `src/worktree/nax-orphan-ref.ts:15`

- Baseline: `naxOrphanRefName(storyId: string): string` returning `refs/nax/orphan/<storyId>`.
- Target: `naxOrphanRefName(worktreeId: WorktreeId): string` returning
  `refs/nax/orphan/<worktreeId>`, so the ref the writer records and the ref the reader looks up
  cannot diverge.

### Failure Handling

| Condition | Behavior |
|:--|:--|
| Feature name or story ID contains characters outside `validateStoryId`'s alphabet | Sanitized during derivation; the resulting identity is always accepted by `validateStoryId`. |
| Natural identity exceeds 64 characters | Truncated with a distinguishing suffix, so two distinct inputs never produce one identity. |
| A branch from before this change (`nax/<storyId>`) is present | Not recognised as this feature's orphan and left untouched; it is neither reused nor deleted. |
| `git worktree add` fails because the composed branch already exists | Unchanged: `WORKTREE_ERROR` naming the branch, as today. |

## Out of Scope

- Legacy `nax/<storyId>` branches created before this feature are not detected, reused or
  deleted, and must be removed manually with `git branch -D`; an automatic sweep would have to
  force-delete a branch a pre-upgrade run in another checkout may still hold.
- Changing the `.nax-wt/<id>` worktree directory to more than two path segments is not part of
  this feature.
- Changing how bakeoff composes its own worktree identity, or the `bakeoff-` prefix, is not part
  of this feature.
- Matching project identity by git remote, and the `RUN_NAME_COLLISION` behaviour of
  `claimProjectIdentity`, are delivered by the project-identity-run-locking feature, not here.
- Run locking, including any lock keyed on a feature, is delivered by the
  project-identity-run-locking feature, not here.
- Introducing branded types anywhere outside the worktree identity is not part of this feature.

## Stories

**US-001 — Branded worktree identity and a branded worktree API**
Extract the shared derivation from `src/bakeoff/worktree-id.ts`, add `deriveStoryWorktreeId` and
`storyBranchName` over a branded `WorktreeId`, and change `WorktreeManager.create`/`remove`,
`MergeEngine.merge`/`mergeAll` and `naxOrphanRefName` to accept the branded identity, taking
every directory, branch and ref spelling from the shared helpers. No dependencies.

**US-002 — Every production call site derives the identity**
Update the six sites that construct a worktree, branch or orphan ref from a raw story ID so each
routes through `deriveStoryWorktreeId` with its run's feature, while every reporting surface
keeps the raw story ID. Depends on US-001.

### Context Files

**US-001**

- `src/bakeoff/worktree-id.ts` — the sanitize, cap and hash-suffix derivation to share
- `src/worktree/manager.ts` — worktree and branch construction, and the three-step cleanup
- `src/worktree/merge.ts` — the second site interpolating the branch name
- `src/worktree/nax-orphan-ref.ts` — the existing one-helper-per-ref-name precedent
- `src/prd/validate.ts` — the alphabet the derivation sanitizes to

**US-002**

- `src/execution/parallel-batch.ts` — creates, removes and maps story worktrees
- `src/execution/iteration-runner.ts` — the sequential `storyIsolation: "worktree"` path
- `src/execution/merge-conflict-rectify.ts` — removes and recreates a worktree during rectification
- `src/execution/pipeline-result-handler.ts` — merges, removes, and writes the orphan ref
- `src/execution/lifecycle/run-initialization.ts` — deletes stale branches before creation

### Creates

**US-001**

- `src/worktree/worktree-id.ts` — the branded identity type, the story derivation and the branch-name helper

### Modifies

**US-001**

- `test/integration/worktree/manager.test.ts` — calls `manager.create(projectRoot, storyId)` and `manager.remove(projectRoot, storyId)` with a raw string story ID, which the branded parameter no longer accepts; the calls must derive an identity and the branch and directory assertions must read the derived value.
- `test/integration/worktree/worktree-merge.test.ts` — asserts the merge commit message and post-cleanup branch absence against `` `nax/${storyId}` `` built from a raw story ID; both must be derived through `storyBranchName`.

**US-002**

- `test/unit/execution/pipeline-result-handler-bug12.test.ts` — exercises the merge and worktree-removal path with a raw story ID; the calls must pass a derived identity once the handler composes one.

### Seams

- `[unit]` stub `deriveStoryWorktreeId`; invoke `runParallelBatch` with a single story; assert `deriveStoryWorktreeId` was called once with the run's feature name and that story's raw ID.
- `[unit]` stub `deriveStoryWorktreeId`; run the iteration runner for one story with `execution.storyIsolation` set to `worktree`; assert `deriveStoryWorktreeId` was called once with the run's feature name and that story's raw ID.
- `[unit]` stub `storyBranchName`; invoke `MergeEngine.merge` with a derived identity; assert `storyBranchName` was called once with that identity and that git received the branch name it returned.

## Acceptance Criteria

### US-001 — Branded worktree identity and a branded worktree API

- `[unit]` `deriveStoryWorktreeId("my-feature", "US-001")` returns `story-my-feature-US-001`.
- `[unit]` `deriveStoryWorktreeId` returns an identity accepted by `validateStoryId` when the feature name contains characters outside `[a-zA-Z0-9._-]`.
- `[unit]` `deriveStoryWorktreeId` returns an identity of at most 64 characters when the natural `story-<feature>-<storyId>` form is longer.
- `[unit]` two distinct feature-and-story pairs whose natural identities share their first 64 characters produce different results from `deriveStoryWorktreeId`.
- `[unit]` `deriveStoryWorktreeId` returns an identity beginning with `story-`.
- `[unit]` `deriveBakeoffWorktreeId` returns an identity beginning with `bakeoff-`.
- `[unit]` `storyBranchName` applied to the identity `story-f-US-001` returns `nax/story-f-US-001`.
- `[unit]` `naxOrphanRefName` applied to the identity `story-f-US-001` returns `refs/nax/orphan/story-f-US-001`.
- `[integration]` `WorktreeManager.create` given the identity derived for feature `f` and story `US-001` creates a worktree directory ending in `.nax-wt/story-f-US-001`.
- `[integration]` `WorktreeManager.create` given the identity derived for feature `f` and story `US-001` creates a branch named `nax/story-f-US-001`.
- `[integration]` `WorktreeManager.remove` given that same identity removes the `nax/story-f-US-001` branch.
- `[unit]` `MergeEngine.merge` given the identity derived for feature `f` and story `US-001` invokes git with the branch name `nax/story-f-US-001`.
- `[integration]` in a repository with a linked git worktree, creating a story worktree for `US-001` under feature `a` from the main checkout and then for `US-001` under feature `b` from the linked worktree both resolve without error.
- `[integration]` after the linked worktree creates its `US-001` worktree for feature `b`, the branch `nax/story-a-US-001` created from the main checkout still exists.

**Out of scope:** pinning the digest algorithm or the input encoding used for the truncation suffix — the observable requirement is that two distinct inputs never collide, and the derivation is shared with `deriveBakeoffWorktreeId` rather than specified independently.

### US-002 — Every production call site derives the identity

- `[unit]` `runParallelBatch` for a story whose raw ID is `US-001` under feature `f` calls `WorktreeManager.create` with the identity `story-f-US-001`.
- `[unit]` `runParallelBatch` maps that story's worktree path to one ending in `.nax-wt/story-f-US-001`.
- `[unit]` the iteration runner with `execution.storyIsolation` set to `worktree` calls `WorktreeManager.create` with the identity `story-f-US-001` for story `US-001` under feature `f`.
- `[unit]` merge-conflict rectification for story `US-001` under feature `f` calls `WorktreeManager.create` with the identity `story-f-US-001`.
- `[unit]` the pipeline result handler merges story `US-001` under feature `f` by calling `MergeEngine.merge` with the identity `story-f-US-001`.
- `[unit]` the pipeline result handler writes its orphan ref for story `US-001` under feature `f` at `refs/nax/orphan/story-f-US-001`.
- `[unit]` run initialization deletes a stale branch named `nax/story-f-US-001` rather than `nax/US-001` when preparing story `US-001` under feature `f`.
- `[unit]` after `runParallelBatch` completes for a story whose raw ID is `US-001`, the returned `storyCosts` map is keyed by `US-001`.
- `[unit]` the story metrics recorded for story `US-001` carry `storyId` equal to `US-001`.
- `[unit]` `packageOverrideKey` applied to `.nax-wt/story-f-US-001/packages/core` returns `packages/core`.
- `[unit]` `storyExecRoot` applied to a repo root with package directory `.nax-wt/story-f-US-001/packages/core` returns the path ending in `.nax-wt/story-f-US-001`.
