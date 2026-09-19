# SPEC: Worktree-Isolation Residuals

**Date:** 2026-09-19
**Closes:** nax#2134, nax#2136
**Related:** nax#2093 (worktree escape), nax#2069 (prefix-derivation trap), PR #2133 (PR4 deletion pass), BUG-28 (`manager.ts:125-133`)

## Summary

Two independent defects that only appear under `execution.storyIsolation: "worktree"`, both of the
same class: a mechanism a docblock declares, which cannot execute. The context engine resolves
file paths against the main checkout while the story executes in a worktree, so a story reads
stale or absent files and is told nothing; and a non-conflict merge failure leaves `nax/<storyId>`
behind in a state the retry path is structurally unable to clean up, so the story is burnt for the
rest of the run behind an error that names the wrong cause.

## Motivation

**nax#2134 — context resolves against the wrong checkout.** After the single-frame deletion pass
(PR #2133), `CodeNeighborProvider` resolves disk paths against `ContextRequest.repoRoot`, which is
the main checkout even under worktree isolation. A file the story created exists only in the
worktree, so `fileExists` reports `false` and the story silently gets no neighbours; reverse-dep
matching can never match because `scanRoot` (the worktree package) and `ownAbsPath` (main) are
different trees; and neighbour headings are spelled `.nax-wt/<storyId>/packages/...`, a path the
agent — rooted at the story execution root — cannot open. `GitHistoryProvider` has the same
defect and already documents it as a RESIDUAL at `git-history.ts:212-219`, asking for exactly the
field this spec adds. The residual was parked deliberately by PR4's controller ruling and is
pinned by a characterization test; it must not ship to `main` unresolved.

**nax#2136 — a merge failure burns the story.** `removeWorktreeDirectory`
(`pipeline-result-handler.ts:50-55`) removes the worktree record and keeps the branch on purpose:
*"This preserves `nax/<storyId>` in git for diagnostics and re-run cleanup."* But
`WorktreeManager.create()`'s only branch-cleanup path (Step 3, `manager.ts:171`) is gated on
`hadWorktreeRecord`, computed from `git worktree list --porcelain` — the record step 1 just
destroyed. So the retry skips Step 3 and dies at `git worktree add` with
`fatal: a branch named 'nax/US-001' already exists`, masking the real merge failure. The
`hadWorktreeRecord` guard is correct and was added by BUG-28 to stop nax force-deleting a *user*
branch of the same name; the defect is that the merge-failure path destroys the guard's evidence
while keeping the thing the guard exists to clean up.

Both are opt-in-only — the default `storyIsolation` is `"shared"`, where `repoRoot` and the story
tree coincide and behaviour is correct.

## Design

### Integration

All symbols below verified against `main` @ `945e1edde`.

**Read-only (no change):**

- `storyExecRoot(view: { readonly repoRoot: string; readonly packageDir?: string }): string` —
  `src/runtime/packages.ts:227`. Returns `join(repoRoot, ".nax-wt", <storyId>)` when `packageDir`
  is a `.nax-wt/...`-relative path, `packageDir` when absolute, else `repoRoot`. Already the
  production source of the agent's root: `src/operations/call-run-options.ts:57,77` and
  `src/operations/call.ts:127,256` both dispatch with `workdir: storyExecRoot(ctx.packageView)`.
- `PipelineContext.packageView?: PackageView` — `src/pipeline/types.ts:165`. Optional. Available
  at both `ContextRequest` producers, which are both typed `PipelineContext`.
- `PackageView.repoRoot` — `src/runtime/packages.ts:22`, documented as *"the MAIN CHECKOUT …
  never re-pointed at a worktree"*.

**Changed — `ContextRequest` (`src/context/engine/types.ts:228`)**

- Baseline (exists only to locate the code, never the interface to implement): the interface
  carries `repoRoot: string` and `packageDir: string` and no worktree-aware root; the
  `storyWorkdir` docblock at `:335` states the frame problem and explicitly forbids deriving a
  worktree root as `packageDirRelative(repoRoot, packageDir)`.
- Target: the interface additionally carries `execRoot?: string` — the absolute directory the
  story's agent actually executes in. Set from `storyExecRoot(ctx.packageView)` by producers that
  hold a `PipelineContext`; **omitted** by producers that do not (the pull-tool handlers
  `handlers/query-neighbor.ts` and `handlers/query-feature-context.ts`, which pass a pre-resolved
  root as both `repoRoot` and `packageDir` and have no story). Consumers read
  `request.execRoot ?? request.repoRoot`, so omission is exactly today's behaviour.

**Changed — `collectNeighbors` (`src/context/engine/providers/code-neighbor.ts:228`)**

- Baseline: takes `repoRoot: string` and resolves `ownAbsPath` (`:238`), `resolveImport` (`:243`),
  `resolvedAbs` (`:245`), the sibling-test probe (`:311`), the sibling `neighbors.add` (`:324`)
  and the final `relative(repoRoot, abs)` spelling against it.
- Target: takes the story execution root in that parameter position; every resolution and the
  return spelling use it. `fetch()`'s `scanRoot` is derived from the same root.

**Changed — `GitHistoryProvider.fetch` workdir (`src/context/engine/providers/git-history.ts:220`)**

- Baseline: `const workdir = request.repoRoot;` under a RESIDUAL comment naming nax#2134.
- Target: `const workdir = request.execRoot ?? request.repoRoot;`, RESIDUAL comment removed. The
  `historyScope` post-filter keeps using `request.storyWorkdir` — it is a selector, not a frame,
  and is unchanged.

**Changed — `removeWorktreeDirectory` (`src/execution/pipeline-result-handler.ts:56`)**

- Baseline: runs `git worktree remove <path> --force` and returns; the branch survives with no
  record that nax owns it.
- Target: on a successful removal it additionally records nax ownership of the surviving branch
  (see Approach), so the branch stays for diagnostics *and* the retry can clean it up.

**Changed — `WorktreeManager.create` (`src/worktree/manager.ts:119`)**

- Baseline: `const hadWorktreeRecord = await this.hasWorktreeRecord(projectRoot, branchName);`
  is the sole evidence gating Step 3's `git branch -D`.
- Target: Step 3 runs when `hasWorktreeRecord(...)` **or** the nax ownership record from
  `removeWorktreeDirectory` is present; the ownership record is cleared with the branch. BUG-28's
  guarantee is unchanged: a user branch named `nax/<storyId>` that nax never created has neither
  form of evidence and is still never force-deleted.

### Approach

For nax#2136 the issue offers two directions: **(a)** record that the surviving branch is a
nax-owned orphan, or **(b)** widen `create()`'s evidence to treat any `nax/<storyId>` branch with
no worktree record and no upstream as an orphan.

**This spec takes (a).** (b) infers ownership from a naming convention, which is precisely the
inference BUG-28 was written to stop — a user branch matching `nax/<storyId>` with no upstream is
indistinguishable from an orphan under (b), so it re-opens the hole the guard closed.

The ownership record is a **git ref**, `refs/nax/orphan/<storyId>`, written with
`git update-ref refs/nax/orphan/<storyId> refs/heads/nax/<storyId>` — the source-ref form, so git
resolves the branch tip itself. The `<sha>` form would need a second `git rev-parse` call and
stdout parsing, which `_worktreeManagerDeps` (it exposes only `gitWithTimeout`) makes awkward for
the read side to mirror.

**The ref name is built in one place.** The record is *written* in `pipeline-result-handler.ts` and
*read* in `worktree/manager.ts` — two modules with two different `_deps` seams. If the two spellings
drift, the record is written and never found, and the mechanism silently never fires: the exact
"declared mechanism that cannot execute" class this spec exists to close. So a single exported
helper, `naxOrphanRefName(storyId)`, owns the spelling and applies `validateStoryId` to its input;
both modules call it rather than interpolating the name themselves. Chosen over a marker file because it is durable across processes and
machines, lives in the same store as the thing it describes, is invisible to `git branch` and
`git log`, and is removed with `git update-ref -d` in the same step that deletes the branch — so
the record cannot outlive what it records. A user branch never acquires one.

### Constraints

- **Injected dependencies.** Every new git invocation routes through the module's existing
  `_deps` seam — `_resultHandlerDeps.spawn` in `pipeline-result-handler.ts:34` and
  `_worktreeManagerDeps.gitWithTimeout` in `manager.ts:18` (which exposes only `gitWithTimeout`).
  A direct `Bun.spawn` / `spawn` call in either module is a forbidden pattern, and AC-2.5 is not
  testable without the seam.
- **Story-id validation on the ref path.** `removeWorktreeDirectory` does not currently validate
  `storyId`; `WorktreeManager.create` does, via `validateStoryId` (`src/prd/validate.ts`, called
  at `manager.ts:120`). An unvalidated id interpolated into `refs/nax/orphan/<storyId>` is a ref
  name built from untrusted input, so the same validation applies wherever the ref name is
  constructed.
- **File-size gate.** `scripts/check-file-sizes.ts:30` sets `SRC_LIMIT = 600` and runs inside
  `bun run lint`. `src/context/engine/types.ts` is **578 lines** — the `execRoot` field plus its
  docblock must stay under ~20 lines or the gate fires. Per nax#2043 this gate is cheapest to
  satisfy at the point of the edit, not after the story is otherwise green; keep the docblock
  terse and cross-reference `storyExecRoot` rather than restating the frame rules.

### Reachability of the cleanup path

`removeWorktreeDirectory` is reached from `handlePipelineFailure` on exactly two branches —
`finalAction: "pause"` (`pipeline-result-handler.ts:357`) and the tier-exhausted
`finalAction: "fail"` (`:394`) — and both are gated on `hasWorktree(ctx.workdir, storyId)`, which
is `existsSync(join(projectRoot, ".nax-wt", storyId))` (`:47`).

**The gate is the worktree directory, not `execution.storyIsolation`.** Per MEM-6 the cleanup keys
off whether a worktree actually exists, "regardless of `storyIsolation` mode". A test that sets
only the config takes the short-circuit branch and never reaches the cleanup path — which is why
`pipeline-result-handler-worktree-cleanup.test.ts:88` sets
`_resultHandlerDeps.existsSync = () => true` explicitly and pins `maxAttemptsTotal: 1` to force
tier exhaustion. Every US-002 AC below states both preconditions for this reason.

### Failure Handling

| condition | behaviour |
|---|---|
| `git update-ref` fails when recording ownership | Best-effort, matching `removeWorktreeDirectory`'s existing contract: log at `warn` on stage `worktree` and continue. The retry then behaves exactly as it does today (fails at `worktree add`), which is the pre-fix status quo, not a new failure. |
| The orphan ref exists but the branch does not | Step 3's `git branch -D` fails; the existing `catch` already swallows it (`manager.ts:178-180`). The ref is deleted regardless, so the state does not persist into a third attempt. |
| `execRoot` absent from a `ContextRequest` | Providers fall back to `request.repoRoot`. This is the pull-tool-handler shape and every pre-existing test shape; behaviour is unchanged. |
| `ctx.packageView` absent on a `PipelineContext` | The producer omits `execRoot` rather than guessing, and the fallback above applies. |

## Out of Scope

- Extending the single-frame design's §6 live verification to cover worktree-isolated context
  resolution. Spec §6 currently asserts exec/write containment only; annotating or extending it is
  tracked on nax#2134 and is not implemented by this spec.
- Any change to `historyScope` semantics, or to the `storyWorkdir` selector, including the
  package post-filter that consumes it.
- Any change to the default `execution.storyIsolation` value, which stays `"shared"`.
- Re-deriving a worktree root from `repoRoot` and `packageDir` by joining or slicing path
  segments. This is the nax#2069 trap and is forbidden; the root comes from `storyExecRoot`.
- Any change to the 40 KiB tool-result cap, the context budget, or rule selection.
- Merge-conflict handling. This spec covers non-conflict merge failures only; a genuine content
  conflict already has its own path.

## Stories

**US-001 — Context providers resolve against the story's execution root** (closes nax#2134)

Thread `execRoot` onto `ContextRequest`, populate it at both producers from
`storyExecRoot(ctx.packageView)`, and resolve and spell `code-neighbor` and `git-history` against
it. No dependency.

**US-002 — A non-conflict merge failure leaves a retryable story** (closes nax#2136)

Record nax ownership of the surviving `nax/<storyId>` branch when the worktree directory is
removed, and accept that record as Step-3 evidence in `WorktreeManager.create`. No dependency;
independent of US-001.

### Dependencies

- **US-001** — no dependencies.
- **US-002** — no dependencies.

The two stories are independent: they share no file, no symbol and no test. US-001 is confined to
the context engine (`src/context/engine/**`, `src/pipeline/stages/context.ts`); US-002 to the
worktree/execution path (`src/worktree/manager.ts`, `src/execution/pipeline-result-handler.ts`).
Either may run first, or both in parallel.

### Context Files

**US-001**

- `src/context/engine/types.ts`
- `src/context/engine/providers/code-neighbor.ts`
- `src/context/engine/providers/git-history.ts`
- `src/context/engine/stage-assembler.ts`
- `src/pipeline/stages/context.ts`

**US-002**

- `src/execution/pipeline-result-handler.ts`
- `src/worktree/manager.ts`

### Creates

Neither story authors a new file; every change is to a file listed above.

### Modifies

**US-001**

- `test/unit/context/engine/providers/code-neighbor-frame.test.ts` — the PARKED characterization
  test at `:253` ("resolution reads the main checkout, not the worktree") asserts that a
  worktree-only neighbour is **absent** (`:280`) and that main-checkout resolution is the
  behaviour. A correct implementation necessarily inverts both assertions. Replace them with the
  worktree-correct invariant: with `execRoot` set to the worktree, the worktree-only neighbour is
  present and no heading carries a `.nax-wt/` prefix. Rename the `describe` block to drop
  "PARKED".

US-002 modifies no existing test. `WorktreeManager.create`'s contract is unchanged for every
input that reaches it today — the new evidence path only widens Step 3 on a state no current test
constructs — so no closed-world assertion in `test/unit/execution/worktree-manager.test.ts` or
`test/unit/execution/pipeline-result-handler-worktree-cleanup.test.ts` is invalidated.

### Seams

- US-001 introduces `ContextRequest.execRoot`. Its producer (`assembleForStage`) and its consumers
  (`CodeNeighborProvider`, `GitHistoryProvider`) are in the same story, so the seam is verified
  inside US-001 by AC-1.7 (producer sets the field) and AC-1.1/AC-1.6 (consumers act on it), not
  across stories.
- US-002 introduces one externally-visible symbol, `naxOrphanRefName`. AC-2.6 exercises it
  directly; its seam is AC-2.1 and AC-2.4, which assert the production path — entered at
  `handlePipelineFailure`, the module's exported entry point — writes and then consumes a ref at
  exactly that name. Both modules that build the name are inside US-002, so the seam does not
  cross a story boundary.
- Every US-002 AC triggers at `handlePipelineFailure` rather than at `removeWorktreeDirectory`,
  which is module-private (`pipeline-result-handler.ts:56`, no `export`) and unreachable from a
  test. The existing `pipeline-result-handler-worktree-cleanup.test.ts:102` uses the same entry
  point.

## Acceptance Criteria

### US-001

1. `[unit]` Given a `ContextRequest` whose `repoRoot` is the main checkout and whose `execRoot` is
   a worktree root, `CodeNeighborProvider.fetch` returns a chunk listing the forward-dep neighbour
   of a touched file when both the touched file and the neighbour exist **only** under `execRoot`.
2. `[unit]` In the same shape, every neighbour path in the returned chunk is spelled relative to
   `execRoot` — no returned path begins with `.nax-wt/`.
3. `[unit]` In the same shape, a worktree-only file that imports the touched file is returned as a
   reverse-dep neighbour.
4. `[unit]` In the same shape, a sibling test file that exists only under `execRoot` is returned
   as a neighbour of its source file.
5. `[unit]` Given a `ContextRequest` with `execRoot` unset, `CodeNeighborProvider.fetch` resolves
   against `repoRoot` and returns the same neighbours it returns today for that input.
6. `[unit]` Given a `ContextRequest` whose `execRoot` is set, `GitHistoryProvider.fetch` invokes
   git with a working directory equal to `execRoot`; with `execRoot` unset it invokes git with a
   working directory equal to `repoRoot`.
7. `[integration]` `assembleForStage`, called with a `PipelineContext` whose `packageView` has
   `repoRoot` `<root>` and `packageDir` `.nax-wt/US-001/packages/app`, builds a `ContextRequest`
   whose `execRoot` is `<root>/.nax-wt/US-001`.
8. `[integration]` `assembleForStage`, called with a `PipelineContext` whose `packageView` has
   `packageDir` `packages/app` (no `.nax-wt` segment), builds a `ContextRequest` whose `execRoot`
   equals `repoRoot`.
9. `[integration]` `assembleForStage`, called with a `PipelineContext` whose `packageView` is
   undefined, builds a `ContextRequest` with `execRoot` unset.

### US-002

1. `[integration]` Given `WorktreeManager.create` created the worktree so `.nax-wt/US-001` exists,
   after `handlePipelineFailure` runs with `finalAction: "fail"` and tiers exhausted for story
   `US-001`, calling `WorktreeManager.create(projectRoot, "US-001")` a second time completes
   without throwing, and a worktree directory exists at `.nax-wt/US-001`.
2. `[unit]` Given a branch `nax/US-001` that exists with no worktree record and no nax ownership
   record — the user-branch shape BUG-28 guards — `WorktreeManager.create(projectRoot, "US-001")`
   does not invoke `git branch -D`, and the branch still resolves to its original commit after the
   call returns.
3. `[unit]` Given `.nax-wt/US-001` exists, after `handlePipelineFailure` runs with
   `finalAction: "fail"` and tiers exhausted for story `US-001`, the branch `nax/US-001` still
   resolves to a commit — the branch is retained for diagnostics, not deleted.
4. `[unit]` When the ownership record is consumed by `WorktreeManager.create`, the record is
   removed: after the call, resolving `refs/nax/orphan/US-001` fails.
5. `[unit]` Given `.nax-wt/US-001` exists and the ownership-record git call fails,
   `handlePipelineFailure` with `finalAction: "fail"` and tiers exhausted returns without throwing
   and a `warn` log is emitted on stage `worktree` carrying the story id.
6. `[unit]` `naxOrphanRefName("US-001")` returns `refs/nax/orphan/US-001`, and throws for a story
   id `validateStoryId` rejects.
7. `[unit]` Given an ownership record for `US-001` but no branch `nax/US-001`,
   `WorktreeManager.create(projectRoot, "US-001")` completes without throwing, and resolving
   `refs/nax/orphan/US-001` fails after the call — the stale record does not survive into a third
   attempt.

<!-- spec-writing: completed-through-phase-5 -->
