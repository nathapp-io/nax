# SPEC: Persist repo-scoped fix records on the PRD story

<!-- spec-writing: completed-through-phase-6 -->

## Summary

`repo-scoped-test-fix` (#1654) dispatches with the story-scope constraint lifted, so its
edits land anywhere in the repository — and they land in the **story's** commit. #1658 /
#1659 made that visible *within a run*: `deriveRepoScopedFixes` builds a
`RepoScopedFixRecord` per dispatch, `StoryOrchestratorResult.repoScopedFixes` carries it,
and the story-summary log line reports it. Nothing writes it to disk. This feature adds a
`repoScopedFixes` field to the PRD story and records each dispatch onto it at the point
the orchestrator result is in hand, so the fact survives the process that produced it.

## Motivation

- **The record dies with the run.** `repoScopedFixes` exists only on the in-memory
  `StoryOrchestratorResult` (`src/execution/story-orchestrator/types.ts:297`) and in the
  JSONL story summary (`execution-plan.ts:494-503`). Nothing writes it to `prd.json`,
  `status.json`, or any other artifact.
- **Every #1660 carrier needs it on disk.** #1660 weighs three ways to annotate a story's
  commits — git notes, an amended trailer, or the PR body — and prefers the PR body. That
  option is currently unreachable: `loadFinishPrContext`
  (`src/finish/pr/context.ts:229-264`) assembles the PR body purely from artifacts on
  disk (`prd.json`, `status.json`, the audit rounds, a diffstat), and `nax finish` is a
  separate phase from the run that produced the records. Persisting the record is the
  prerequisite #1660 assumes is already done.
- **Post-hoc analysis silently over-attributes.** "What did this story change" currently
  absorbs repairs the story did not originate, with no on-disk field that discriminates
  them.

## Design

### Approach

A **post-hoc annotation on the story object**, not a change to any commit path and not a
new persistence call.

`story.storyGitRef` establishes the pattern: `iteration-runner.ts:104-118` mutates the
live `UserStory` and lets a `savePRD` carry it, and `parallel-worker.ts:53-62` does the
same in the worktree path. This feature mirrors it exactly — write onto `ctx.story`, rely
on the saves that already run.

**Write to `ctx.story`, never `ctx.prd`.** In parallel mode
`buildWorktreePipelineContext` (`parallel-worker.ts:26-30`) deep-clones `prd` via
`structuredClone` while passing `story` by reference, so a mutation of `ctx.prd` is
discarded and a mutation of `ctx.story` is not. This is the same asymmetry
`parallel-worker.ts:61` already depends on for `storyGitRef`.

The existing saves that carry the write:

| Path | Save point |
|:---|:---|
| Sequential, story passed | `completionStage` → `savePRD(ctx.prd, prdPath)` (`stages/completion.ts:200-202`), which runs immediately after `executionStage` in `defaultPipeline` (`stages/index.ts:32-41`) |
| Sequential, story failed | `handlePipelineFailure` → `markStoryFailed` + `savePRD` (`pipeline-result-handler.ts:337`, `:371`) |
| Parallel worktree | `reconcileBatchOutcome(prd, batchResult)` + `savePRD(prd, ctx.prdPath)` (`unified-executor.ts:383-384`) — worktree pipelines set `skipPrdPersistence`, so the executor is the single writer |

**Why not `handlePipelineSuccess`.** `outputFiles` / `diffSummary` are written there
(`pipeline-result-handler.ts:192-206`) with no following `savePRD`, and the executor
reloads the PRD from disk after every story (`unified-executor.ts:214-216`, `:544-547`).
That module's own comment at `:87-89` states the rule those lines do not follow. This
feature writes earlier — inside the execution stage — so an existing save always follows
it, and takes no dependency on those two fields.

### Integration (extends existing code)

This feature changes four symbols. Each baseline is stated only to locate the code; it is
never the interface to implement.

**`UserStory`** — `src/prd/types.ts:233` (US-001)
- Baseline: the interface ends with `storyGitRef?: string`.
- Target: the same, plus an optional `repoScopedFixes?: PersistedRepoScopedFix[]`
  declared alongside it, and a new exported `PersistedRepoScopedFix` interface in the
  same module.

**`resetFailedStoriesToPending`** — `src/prd/index.ts:319` (US-001)
- Baseline: `resetFailedStoriesToPending(prd: PRD, opts: ResetFailedOptions = {}): UserStory[]`,
  which sets `story.storyGitRef = undefined` when `resetRef || storyIsolation === "worktree"`.
- Target: the same signature; that same branch additionally sets
  `story.repoScopedFixes = undefined`.

**`repo-scoped-fix-record.ts`** — `src/execution/story-orchestrator/repo-scoped-fix-record.ts` (US-002)
- Baseline: exports `REPO_SCOPED_STRATEGY_NAME`, `RepoScopedFixRecord`, and
  `deriveRepoScopedFixes`.
- Target: the same, plus an exported
  `recordRepoScopedFixes(story: UserStory, records: readonly RepoScopedFixRecord[] | undefined): void`,
  which imports `UserStory` and `PersistedRepoScopedFix` from the `@/prd` barrel (never a
  leaf path — `project-conventions.md` § Module Structure), and is re-exported from `src/execution/story-orchestrator/index.ts` and `src/execution/index.ts`
  alongside the existing `RepoScopedFixRecord` export.

**`executionStage` / `_executionDeps`** — `src/pipeline/stages/execution.ts:156-181` (US-002)
- Baseline: `plan.run()` resolves into `planResult`, which is passed to
  `applyPostRunInspection` and `decideStageAction`; `_executionDeps` holds eight keys
  ending at `decideStageAction`.
- Target: `_executionDeps` gains a `recordRepoScopedFixes` key; `executionStage.execute`
  calls `_executionDeps.recordRepoScopedFixes(ctx.story, planResult.repoScopedFixes)`
  after the `try`/`catch`/`finally` around `plan.run()` and before
  `applyPostRunInspection`.

Symbols this feature reads but does **not** change:

- `RepoScopedFixRecord` — `src/execution/story-orchestrator/repo-scoped-fix-record.ts:22`;
  fields `triggeringTests: readonly string[]`, `filesChanged: readonly string[]`,
  `declinedReason?: string`, `findingsCleared: boolean`.
- `StoryOrchestratorResult.repoScopedFixes?: readonly RepoScopedFixRecord[]` —
  `src/execution/story-orchestrator/types.ts:77`.
- `loadPRD(path)` / `savePRD(prd, path)` — `src/prd/index.ts:53`, `:106`. `loadPRD` reads
  plain JSON and normalises a fixed field list; it neither validates against a schema nor
  strips unknown keys, so no migration is required. `validateStory` in `src/prd/schema.ts`
  does whitelist fields, but runs only on `nax plan` LLM output, upstream of execution.
- `iteration-runner.ts:104-118` — the `storyGitRef` mutate-then-save precedent.
- `parallel-worker.ts:26-30`, `:53-62` — the `structuredClone(prd)` / live-`story`
  asymmetry.

### File Format — the persisted entry

`PersistedRepoScopedFix` is declared in `src/prd/types.ts` and deliberately does **not**
reuse `RepoScopedFixRecord`: `src/prd` imports nothing from `src/execution` today, and
keeping the on-disk shape separate lets the in-memory record change without a `prd.json`
migration. `recordRepoScopedFixes` maps between them.

```ts
/** One repo-scoped repair (#1654) that landed in this story's commits. */
export interface PersistedRepoScopedFix {
  /** Failing tests that triggered the dispatch, as `file::testName`. */
  triggeringTests: string[];
  /**
   * Files the dispatch changed, sourced from git. Empty means the dispatch
   * changed nothing — never that it succeeded.
   */
  filesChanged: string[];
  /**
   * Were the findings gone after this dispatch? NOT a claim the fix worked —
   * the verifier-SSOT carve-out also clears findings. `filesChanged` is the
   * field that discriminates.
   */
  findingsCleared: boolean;
}
```

As it appears on a story in `prd.json`:

```json
{
  "id": "US-003",
  "title": "Add the retry budget",
  "status": "passed",
  "storyGitRef": "a1b2c3d",
  "repoScopedFixes": [
    {
      "triggeringTests": ["test/unit/queue/drain.test.ts::drains on abort"],
      "filesChanged": ["src/queue/drain.ts"],
      "findingsCleared": true
    }
  ]
}
```

`declinedReason` is not persisted — it is rectification-internal diagnostics, already in
the JSONL run log, and not something a PR reader can act on.

### Failure Handling

- **No dispatch → no field.** An absent or empty `records` argument is a no-op:
  `story.repoScopedFixes` is left untouched, and an empty array is never written. Absence
  of the field means "no repo-scoped dispatch"; `[]` would be an ambiguous third state.
- **Fail-open, synchronously.** `recordRepoScopedFixes` is synchronous — it returns
  `void`, not `Promise<void>`, so it performs no awaited persistence and the write is
  carried entirely by the saves already listed above. It cannot fail the exit path of a
  story that otherwise passed, and it cannot slow it down.
- **`plan.run()` throws → nothing recorded.** There is no result to record from; the
  existing rethrow is unchanged.
- **Story failed → records kept.** An escalating story keeps its worktree and its commits,
  so the repairs are still in the branch and the records still describe it.
- **Reset discards the records with the commits.** Under `resetRef` or worktree isolation,
  the reset clears `storyGitRef` because the commits it described are gone; the records
  describe those same commits and are cleared with it. A stale record is worse than an
  absent one — it reads as "this branch contains a repair" when it does not.

## Out of Scope

- Adding a git trailer, a git note, or an amended commit message to a story's commits is
  deferred to issue #1660.
- Rendering repo-scoped fix records in the PR body composed by `src/finish/pr/body.ts` is
  deferred to a follow-up spec.
- The `declinedReason` field of `RepoScopedFixRecord` is deliberately not persisted and
  stays only in the JSONL run log.
- Fixing the pre-existing loss of `outputFiles` and `diffSummary`, which
  `handlePipelineSuccess` writes without a following `savePRD`, belongs to its own issue.
- No cap is placed on the number of persisted entries per story; growth is bounded by
  `execution.rectification.maxAttemptsTotal` and is not managed here.
- Backfilling `repoScopedFixes` onto PRDs from runs that completed before this feature is
  not attempted.
- Persisting records for stories that never reach the execution stage — skipped, blocked,
  or queue-aborted — is not attempted.
- US-002 only: cross-process or cross-worker synchronisation of `repoScopedFixes` writes
  is out of scope, because each story object is written by exactly one worker.
- US-002 only: records written after the last `savePRD` of a run that then crashes are
  lost; no new save point is added to narrow that window.

## Stories

Two stories, linear dependency. US-001 extends the type system; US-002 depends on it.

### US-001 — Persisted record type and reset invariant

Add the `PersistedRepoScopedFix` interface and the optional `repoScopedFixes` field to
`UserStory` in `src/prd/types.ts`, export the type from the `src/prd` barrel, and make
`resetFailedStoriesToPending` clear the field under exactly the condition that already
clears `storyGitRef`.

- **Depends on:** none.
- **Context Files (reads):** `src/prd/types.ts`, `src/prd/index.ts`,
  `test/unit/prd/prd-reset-failed.test.ts`, `test/unit/prd/prd-auto-default.test.ts`.
- **Creates:** none — `test/unit/prd/prd-reset-failed.test.ts` (reset ACs) and
  `test/unit/prd/prd-auto-default.test.ts` (the `loadPRD`/`savePRD` round-trip ACs, which
  belong with the loader's existing normalisation tests) are the right homes
  (test-architecture rule 2: never create a standalone bug-fix test file). Not
  `test/unit/prd/schema.test.ts` — that file covers `validatePlanOutput` and sits at 743
  of its 800-line limit.

### US-002 — Record the dispatch onto the story

Add `recordRepoScopedFixes(story, records)` to
`src/execution/story-orchestrator/repo-scoped-fix-record.ts`, mapping each
`RepoScopedFixRecord` to a `PersistedRepoScopedFix` and appending to
`story.repoScopedFixes`. Re-export it from the story-orchestrator and execution barrels,
register it on `_executionDeps`, and call it from `executionStage.execute` once `plan.run()`
has resolved.

- **Depends on:** US-001 (`PersistedRepoScopedFix` and the `UserStory` field from `@/prd`).
- **Context Files (reads):**
  `src/execution/story-orchestrator/repo-scoped-fix-record.ts`,
  `src/pipeline/stages/execution.ts`,
  `src/execution/story-orchestrator/index.ts`,
  `src/execution/parallel-worker.ts`,
  `test/unit/pipeline/stages/execution-phase-telemetry.test.ts` (existing
  `_executionDeps` stubbing pattern to mirror).
- **Creates:**
  `test/unit/execution/story-orchestrator/repo-scoped-fix-record.test.ts`,
  `test/unit/pipeline/stages/execution-repo-scoped-fixes.test.ts`.

**Out of scope:**
- Cross-process or cross-worker synchronisation of the write — each story object is
  mutated by exactly one worker, so no locking is specified.
- Narrowing the crash window between the write and the next `savePRD` — no new save
  point is added.

### Modifies

None. No existing test pins a closed-world shape this feature changes: neither
`test/unit/prd/prd-reset-failed.test.ts` nor any
`test/unit/pipeline/stages/execution-*.test.ts` uses `toStrictEqual` or a whole-story
`toEqual`, and every new field is optional and absent unless a dispatch fired.

### Seams

- **`recordRepoScopedFixes` (US-002 producer and consumer, one story).** The symbol is new
  and its only production caller is `executionStage.execute`. US-002 declares a seam AC that
  spies `_executionDeps.recordRepoScopedFixes`, triggers the stage at its outermost
  production entry point — `executionStage.execute(ctx)`, above the empty-records guard — and
  asserts the spy was invoked with `ctx.story` and the orchestrator result's records. The
  guard is exercised by a paired AC asserting a result carrying no records leaves the
  field undefined.
- **`PersistedRepoScopedFix` / `UserStory.repoScopedFixes` (US-001 → US-002).** US-001
  declares the shape and its round-trip through `savePRD`/`loadPRD`; US-002's recorder is
  the only writer. US-002's seam AC above proves the field is written on the production
  path, not merely declared.

## Acceptance Criteria

### US-001 — Persisted record type and reset invariant

1. `[unit]` Given a PRD whose story carries a `repoScopedFixes` array of one value
   satisfying `PersistedRepoScopedFix` (`triggeringTests`, `filesChanged`,
   `findingsCleared`), `savePRD` followed by `loadPRD` of the same path returns a story
   whose `repoScopedFixes` deep-equals the written array.
2. `[unit]` `loadPRD` of a `prd.json` whose stories carry no `repoScopedFixes` key returns
   stories whose `repoScopedFixes` is `undefined` — no default array is injected.
3. `[unit]` `resetFailedStoriesToPending(prd, { resetRef: true })` sets `repoScopedFixes`
   to `undefined` on every story it resets.
4. `[unit]` `resetFailedStoriesToPending(prd, { storyIsolation: "worktree" })` sets
   `repoScopedFixes` to `undefined` on every story it resets, with `resetRef` left at its
   default `false`.
5. `[unit]` `resetFailedStoriesToPending(prd, {})` leaves `repoScopedFixes` unchanged on
   the stories it resets — the same call that leaves `storyGitRef` intact.
6. `[unit]` `resetFailedStoriesToPending(prd, { resetRef: true })` leaves
   `repoScopedFixes` unchanged on a story whose `status` is `"passed"` (only `"failed"`
   stories are reset).

### US-002 — Record the dispatch onto the story

1. `[unit]` `recordRepoScopedFixes(story, records)` with a one-element `records` array
   leaves `story.repoScopedFixes` deep-equal to a one-element array whose entry is
   `{ triggeringTests, filesChanged, findingsCleared }` copied from that record.
2. `[unit]` Given a source `RepoScopedFixRecord` carrying `declinedReason: "gave up"`,
   `recordRepoScopedFixes` leaves `story.repoScopedFixes` deep-equal to a one-element
   array whose entry has exactly the keys `triggeringTests`, `filesChanged` and
   `findingsCleared` — no `declinedReason` key.
3. `[unit]` `recordRepoScopedFixes(story, records)` with a two-element `records` array
   leaves `story.repoScopedFixes` deep-equal to a two-element array in the same order as
   `records` (one cycle can dispatch more than once).
4. `[unit]` `recordRepoScopedFixes(story, records)` on a story whose `repoScopedFixes`
   already holds one entry leaves `story.repoScopedFixes` deep-equal to that pre-existing
   entry followed by the new one — records accumulate across attempts rather than
   replacing.
5. `[unit]` `recordRepoScopedFixes(story, [])` leaves `story.repoScopedFixes` `undefined`
   — an empty array is never written.
6. `[unit]` `recordRepoScopedFixes(story, undefined)` leaves `story.repoScopedFixes`
   `undefined`.
7. `[unit]` `recordRepoScopedFixes(story, records)` returns `undefined` and not a
   `Promise` — the recorder is synchronous and performs no awaited persistence.
8. `[unit]` `recordRepoScopedFixes` is importable from `@/execution` and is usable as a
   function.
9. `[integration]` Given `executionStage.execute(ctx)` with `_executionDeps.buildPlanForStrategy`
   stubbed to return a plan whose `run()` resolves a `StoryOrchestratorResult` carrying a
   one-element `repoScopedFixes` array, and `_executionDeps.recordRepoScopedFixes`
   replaced by a spy, the spy is invoked exactly once with `ctx.story` as its first
   argument and that same records array as its second.
10. `[integration]` Given the same stubbed plan with both `_executionDeps.recordRepoScopedFixes`
    and `_executionDeps.applyPostRunInspection` replaced by spies, `executionStage.execute(ctx)`
    invokes `recordRepoScopedFixes` before `applyPostRunInspection`.
11. `[integration]` Given `executionStage.execute(ctx)` with a stubbed plan whose
    `StoryOrchestratorResult` carries no `repoScopedFixes`, `ctx.story.repoScopedFixes` is
    `undefined` after the stage returns.
12. `[integration]` Given `executionStage.execute(ctx)` with a stubbed plan whose
    `StoryOrchestratorResult` has `success: false` and a one-element `repoScopedFixes`
    array, `ctx.story.repoScopedFixes` has length 1 after the stage returns — records are
    kept on the failure path.
13. `[integration]` Given `executionStage.execute(ctx)` with a stubbed plan whose `run()`
    rejects, awaiting `executionStage.execute(ctx)` rejects with that same error and
    `ctx.story.repoScopedFixes` is `undefined`.

**Verification note (US-002 barrel wiring):** the re-exports through
`src/execution/story-orchestrator/index.ts` and `src/execution/index.ts` are thin
declarations verified by the build/static gate — `bun run typecheck` and `bun run lint`
— beyond the import asserted by AC 7.
