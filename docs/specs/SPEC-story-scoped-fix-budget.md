# SPEC: Story-scoped fix budget and decline ledger

## Summary

Make the fix cycle's attempt budget, per-strategy caps, decline ledger, and no-progress bail streak accumulate across every rectification re-entry for a story, instead of resetting each time `runRectification` builds a fresh `FixCycle`. State lives in a run-scoped map on `NaxRuntime`, keyed by story and escalation tier, and reaches `runFixCycle` through a new read-only `FixCycle.priorIterations` field that leaves the existing `iterations` array — and every consumer of it — untouched.

## Motivation

`runFixCycle` bounds work with three mechanisms that all derive from `cycle.iterations`: a per-strategy cap (`maxAttemptsPerStrategy`, default 3), a total cap (`maxAttemptsTotal`, default 12), and `bailWhen` predicates. `runRectification` constructs the cycle with `iterations: []` on **every** call (`src/execution/story-orchestrator/rectification.ts:290`), and it is called repeatedly for one story: the main pass (`execution-plan.ts:179`), the post-rectification resume pass (`execution-plan.ts:231`), and again on each escalation attempt. Every caller therefore starts from zero.

The caps are enforced faithfully *within* each cycle and bound nothing a user would recognise as "attempts to fix this defect."

Measured across `~/.nax/*/prompt-audit` for every project on this machine: **1253** `(run, story, strategy)` triples received at least one fix dispatch, and **119 of them (9%) exceeded the per-strategy cap of 3** — 29 at seven or more. The worst is `nax story-orchestrator US-004` at **14** `implementer-rectification` dispatches under a cap of 3. Those 119 triples consumed **674** dispatches where a story-wide cap would have permitted at most 357.

The decline ledger resets identically, so a strategy that answered UNRESOLVED for a finding is re-dispatched for that same finding on the next cycle with no record that it already gave up.

The reset also defeats the bail shipped in #1498. `withNoProgressBail` reads its streak from the array passed to `bailWhen`, which is `cycle.iterations` (`src/execution/story-orchestrator/no-progress-bail.ts:30`, `src/findings/cycle.ts:264`). Three consecutive non-progressing iterations exit the cycle, `ExecutionPlan` re-enters, and the streak restarts at zero. Until the history carries across re-entry, the identity-keyed bail bounds a cycle rather than a story.

This is item R1 of the 2026-08-07 rectification-lane gap analysis, and the last of its findings that changes control flow.

## Design

A run-scoped `Map<string, StoryFixState>` on `NaxRuntime`, sitting beside the existing `rectificationOscillations`, `adversarialIterations`, and `semanticIterations` maps — the established precedent for per-story state threaded across per-attempt `PipelineContext` rebuilds.

```typescript
export interface StoryFixState {
  /** Iterations from every prior cycle for this (story, tier), in completion order. */
  readonly iterations: Iteration<Finding>[];
  /** Backing store for the decline ledger: strategy name -> declined findingKey set. */
  readonly declines: Map<string, Set<string>>;
}
```

The key is `` `${storyId}::${tier}` ``, where `tier` is `ctx.phaseTelemetry?.tier`. Escalating a story to a higher model tier therefore yields a fresh budget: a more capable model gets a real attempt, while the main-pass and resume-pass re-entries that produce the 119 overruns collapse onto one budget.

### Approach

Three shapes were considered. Seeding `cycle.iterations` directly is the smallest diff, but it retroactively changes the meaning of three existing consumers — most seriously `countOscillationOutcomes(cycleResult.iterations)` at `rectification.ts:436`, whose result is **accumulated** into the run-scoped `rectificationOscillations` map by `recordOscillations`, so a longer array double-counts earlier cycles' oscillations into the run total. Threading separate counters avoids that but duplicates the derivation that `countStrategyAttempts`, `countTotalAttempts`, and `madeNoProgress` already own, creating a second source of truth for "how many attempts."

The chosen shape is an explicit read-only carry-in field, `FixCycle.priorIterations`, kept distinct from `iterations`. The counters and the bail predicate read the concatenation; `cycle.iterations` and `FixCycleResult.iterations` keep exactly their current this-cycle meaning, so oscillation counting, `phaseOutputs.rectification.iterationCount`, and `recordIteration`'s `iterationNum` need no changes and cannot regress.

### New symbols

All introduced by US-001 in `src/findings/story-fix-history.ts` and re-exported from the `src/findings/index.ts` barrel. Consumers import them from `@/findings`, never from the leaf path — the repo bans internal-path value imports and enforces it with `bun run check:alias-internals`.

| Symbol | Kind | Purpose |
|:---|:---|:---|
| `StoryFixState` | interface | `{ iterations, declines }` for one `(story, tier)` |
| `StoryFixHistory` | type | `Map<string, StoryFixState>` |
| `createStoryFixHistory()` | function | Construct an empty store |
| `storyFixKey(storyId, tier?)` | function | Derive the map key; `tier` defaults to `"default"` |
| `getStoryFixState(store, key)` | function | Read a state, creating an empty one on miss |
| `appendStoryFixIterations(store, key, iterations)` | function | Append this cycle's iterations to the state |

`FixCycle.priorIterations` (US-002) and `execution.rectification.storyScopedFixBudget` (US-001) are the other two additions.

### Integration

Verified against `main` at `4f44f62a`.

| Symbol | Location | Change |
|:---|:---|:---|
| `FixCycle<F>` | `src/findings/cycle-types.ts:199` | Add `priorIterations?: readonly Iteration<F>[]` |
| `Iteration<F>` | `src/findings/cycle-types.ts:35` | Unchanged; consumed as-is |
| `countStrategyAttempts` | `src/findings/cycle.ts:130` | Unchanged signature; call sites pass the concatenation |
| `countTotalAttempts` | `src/findings/cycle.ts:137` | Unchanged signature; call site passes the concatenation |
| `runFixCycle` read sites | `src/findings/cycle.ts:225, 227, 245, 264, 396` | Switch from `cycle.iterations` to a loop-local concatenation |
| `createDeclineLedger<F>` | `src/findings/cycle-retirement.ts:66` | Accept an optional caller-supplied backing `Map<string, Set<string>>` and read/write through it |
| `src/findings/index.ts` | barrel | Re-export the new store symbols and the `StoryFixState` / `StoryFixHistory` types |
| `NaxRuntime` | `src/runtime/index.ts:139` (interface), `:278` (construction), `:306` (return) | Add `storyFixHistory` |
| `runRectification` | `src/execution/story-orchestrator/rectification.ts:288-305` | Seed `priorIterations` + ledger backing; append this cycle's iterations on exit |
| Config (nested schema) | `src/config/schemas-execution.ts:75` | Add `storyScopedFixBudget: z.boolean().default(true)` |
| Config (default literal) | `src/config/schemas.ts:128` | Add `storyScopedFixBudget: true` |
| `RectificationConfig` | `src/config/runtime-types.ts:66` | Add `storyScopedFixBudget: boolean` |

All five `runFixCycle` read sites are reached **before** the iteration is pushed within the same loop pass, so a single concatenation computed at the top of the loop body is correct at every one of them.

Zod does not merge the default literal in `schemas.ts` with the nested schema in `schemas-execution.ts`; both must declare the field. This is the defect pattern from #1498.

`src/findings/cycle.ts` is 584 lines against the repo's 600-line hard limit, so the store is a new file (`src/findings/story-fix-history.ts`) and the edits inside `cycle.ts` must stay near net-zero.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `storyScopedFixBudget` is `false` | `priorIterations` is not passed and no store read or write occurs — behaviour is byte-for-byte today's per-cycle semantics. |
| `ctx.runtime.storyFixHistory` is absent (partial or plugin-supplied runtime) | Fail open to per-cycle behaviour. Never throw. |
| `ctx.phaseTelemetry` is absent, so no tier is available | Key on the literal tier `"default"`. All of that story's cycles then share one budget, which bounds more tightly rather than less. |
| `ctx.storyId` is absent | `runRectification` already returns before constructing the cycle (`rectification.ts:272`); the store read and write must both sit after that guard, so no state is recorded. |
| Non-blocking-fix call site (`execution-plan.ts:341`) | Opts out entirely. It fixes advisory findings on an already-green story with a different strategy set, and keeps its own per-cycle budget. |

## Out of Scope

- Re-keying oscillation counting from source identity to finding identity. `countOscillationOutcomes` remains source-level and is not modified by this work; that is gap-analysis item R4, to be re-probed after this lands.
- Reading the oscillation circuit-breaker mid-story. It continues to be read only on the story-failure path in `src/execution/post-run.ts`.
- Stating prior attempts explicitly in the fix prompt. The `prior` parameter of `FixStrategy.buildInput` remains unconsumed by all six strategies, and no prompt text changes; that is gap-analysis item R2, an experiment rather than a fix.
- Modifying `classifyOutcome` in `src/findings/cycle.ts`. Its behaviour is correct and is relied upon unchanged.
- Changing any reviewer prompt, semantic or adversarial.
- Carrying the fix budget across escalation tiers. A tier change deliberately yields a fresh budget so that escalation to a more capable model still gets real attempts.
- Story-scoping the budget of the non-blocking-fix path. It retains its own independent per-cycle budget.
- Story-scoping the fix cycles driven by `src/execution/lifecycle/acceptance-loop.ts` and `src/execution/lifecycle/run-regression.ts`. Both call `runFixCycle` directly, are not per-story rectification, and remain per-cycle.
- Changing the numbering of `Iteration.iterationNum`, which stays 1-indexed within each cycle.

## Stories

Dependency chain: US-001 -> US-002 -> US-003 -> US-004.

### US-001 — Run-scoped story fix history store and config knob

Introduce `StoryFixState`, the store and its key derivation, the `NaxRuntime` field, and the `storyScopedFixBudget` config knob threaded through both Zod declaration sites and the runtime config type. No behaviour changes in the fix cycle yet.

**Creates**
- `src/findings/story-fix-history.ts`

**Context Files**
- `src/runtime/index.ts`
- `src/config/schemas-execution.ts`
- `src/config/schemas.ts`
- `src/config/runtime-types.ts`
- `src/findings/cycle-types.ts`

### US-002 — `runFixCycle` consumes the carried history

Add `priorIterations` to `FixCycle`, compute the concatenation once per loop pass, and switch the two cap checks, the terminal-exhaustion check, and the `bailWhen` call to read it. Give `createDeclineLedger` an optional caller-supplied backing map. `FixCycleResult.iterations` continues to report only this cycle.

**Context Files**
- `src/findings/cycle.ts`
- `src/findings/cycle-types.ts`
- `src/findings/cycle-retirement.ts`
- `src/execution/story-orchestrator/no-progress-bail.ts`
- `src/findings/story-fix-history.ts` — created by US-001, consumed here

### US-003 — `runRectification` seam and the shared budget

Seed `priorIterations` and the ledger backing from the store, append the cycle's iterations on exit, derive the key from story and tier, and honour the config knob. Proves the budget is genuinely shared across the re-entries that motivated the work.

**Context Files**
- `src/execution/story-orchestrator/rectification.ts`
- `src/execution/story-orchestrator/execution-plan.ts`
- `src/findings/story-fix-history.ts` — created by US-001, consumed here
- `src/runtime/index.ts`
- `src/operations/types.ts`

### US-004 — Invariant preservation and failure handling

Leave the non-blocking-fix call site opted out, and prove the carry-in changes nothing it must not: oscillation totals, per-cycle iteration reporting, and cross-story isolation. Covers every `### Failure Handling` row not already pinned by US-003.

**Context Files**
- `src/execution/story-orchestrator/rectification.ts`
- `src/execution/story-orchestrator/execution-plan.ts`
- `src/execution/oscillation-store.ts`
- `src/findings/story-fix-history.ts` — created by US-001, consumed here
- `src/runtime/index.ts`

### Seams

- **US-001 -> US-003.** The store's exported functions are called only from `runRectification`. US-003's acceptance criteria trigger production entry points and assert the resulting store contents, rather than asserting that the store functions were called.
- **US-002 -> US-003.** `priorIterations` is populated only by `runRectification`. US-003 asserts the observable consequence: a second cycle for the same story and tier finds its budget already spent.
- **Seam altitude.** `runRectification` is not the outermost entry point. The re-entry this feature exists to bound is produced by `ExecutionPlan.run`, which calls `runRectification` for the main pass and again for the post-rectification resume pass, rebuilding context between them. AC-3.6 therefore drives `ExecutionPlan.run` itself, so that a wiring bug in which the two passes reach different runtime instances — the failure mode that would silently defeat the whole feature — cannot ship green. `ExecutionPlan.run` is already driven this way in `test/unit/execution/story-orchestrator-resume-guard.test.ts`.

## Acceptance Criteria

### US-001

- AC-1.1 `[unit]` Resolving a configuration in which `execution.rectification.storyScopedFixBudget` is unset yields the value `true`.
- AC-1.2 `[unit]` Resolving a configuration in which a project layer sets `execution.rectification.storyScopedFixBudget` to `false` yields the value `false`.
- AC-1.3 `[unit]` Rejecting a non-boolean: parsing a configuration whose `execution.rectification.storyScopedFixBudget` is the string `"yes"` fails validation rather than coercing.
- AC-1.4 `[unit]` `storyFixKey` called with story id `"US-004"` and tier `"fast"` returns a value different from the value it returns for story id `"US-004"` and tier `"powerful"`.
- AC-1.5 `[unit]` `storyFixKey` called with story id `"US-004"` and no tier returns the same value as calling it with story id `"US-004"` and tier `"default"`.
- AC-1.6 `[unit]` `getStoryFixState` called on a freshly created store with a key never written returns a state whose `iterations` is empty and whose `declines` map is empty.
- AC-1.7 `[unit]` After `appendStoryFixIterations` is called with a key and two iterations, `getStoryFixState` for that key returns those two iterations in the order supplied.
- AC-1.8 `[unit]` Calling `appendStoryFixIterations` twice for the same key with one iteration each yields a state whose `iterations` has length 2, demonstrating append rather than replace.
- AC-1.9 `[unit]` Appending iterations under one key leaves the state retrieved under a different key with an empty `iterations` array.
- AC-1.10 `[integration]` A runtime constructed by `createRuntime` exposes `storyFixHistory`, and two successive reads of that property return the same instance.

### US-002

- AC-2.1 `[unit]` `runFixCycle` given a cycle whose `priorIterations` contains three iterations each recording one fix applied by strategy `"S"`, where `"S"` has `maxAttempts` 3, returns `exitReason` `"max-attempts-per-strategy"` with `exhaustedStrategy` `"S"` and dispatches no fix operation.
- AC-2.2 `[unit]` The same cycle with only two such prior iterations dispatches strategy `"S"` exactly once before its next cap check.
- AC-2.3 `[unit]` `runFixCycle` given `priorIterations` whose recorded fixes total the cycle's `maxAttemptsTotal` returns `exitReason` `"max-attempts-total"` and dispatches no fix operation.
- AC-2.4 `[unit]` With a no-progress bail threshold of 3, a cycle whose `priorIterations` are two iterations in which every finding present before is still present after, and whose first live iteration is likewise non-progressing, returns `exitReason` `"bail-when"`.
- AC-2.5 `[unit]` With the same threshold of 3 and the same two non-progressing prior iterations, a cycle whose first live iteration resolves a finding does not return `exitReason` `"bail-when"`.
- AC-2.6 `[unit]` A cycle with `priorIterations` omitted and a strategy capped at 3 attempts dispatches that strategy three times before exiting, matching the behaviour when the field did not exist.
- AC-2.7 `[unit]` A cycle seeded with three `priorIterations` that runs exactly one live iteration returns a `FixCycleResult` whose `iterations` has length 1.
- AC-2.8 `[unit]` A cycle seeded with three `priorIterations` records its first live iteration with `iterationNum` equal to 1.
- AC-2.9 `[unit]` `createDeclineLedger` given a backing map in which strategy `"S"` has already declined a finding reports that strategy as retired for that finding without any call to `recordDeclined` in this cycle.
- AC-2.10 `[unit]` `createDeclineLedger` given a backing map, after `recordDeclined` is called for strategy `"S"` and a finding, leaves that finding's key present under `"S"` in the caller's map, so a later ledger built over the same map reports `"S"` retired for it.
- AC-2.11 `[unit]` `createDeclineLedger` called with no backing map reports no strategy retired for any finding until `recordDeclined` is called.

### US-003

- AC-3.1 `[integration]` With `storyScopedFixBudget` enabled, invoking `runRectification` twice for the same story id and the same tier, where the first invocation exhausts the per-strategy cap, causes the second invocation to dispatch no fix operation.
- AC-3.2 `[integration]` In the scenario of AC-3.1, the second invocation records `exitReason` `"max-attempts-per-strategy"` in its rectification phase output.
- AC-3.3 `[integration]` With `storyScopedFixBudget` disabled, the same two invocations cause the second invocation to dispatch fix operations, matching pre-change behaviour.
- AC-3.4 `[integration]` With `storyScopedFixBudget` enabled, two invocations for the same story id whose `phaseTelemetry.tier` differs cause the second invocation to dispatch fix operations, demonstrating the per-tier reset.
- AC-3.5 `[integration]` After one `runRectification` invocation that runs two iterations, the story's state retrieved from the runtime's `storyFixHistory` has an `iterations` length of 2; after a further invocation running one iteration, that length is 3.
- AC-3.6 `[integration]` Driving `ExecutionPlan.run` over one story with `storyScopedFixBudget` enabled, on a plan whose main rectification pass exhausts the per-strategy cap and whose post-rectification resume pass then invokes rectification a second time, causes that second pass to dispatch no fix operation.
- AC-3.7 `[integration]` Driving the same plan as AC-3.6 with `storyScopedFixBudget` disabled causes the resume pass to dispatch fix operations.

### US-004

- AC-4.1 `[integration]` Invoking `runRectification` through the non-blocking-fix override path leaves the runtime's `storyFixHistory` with no state recorded for that story.
- AC-4.2 `[integration]` After a non-blocking-fix invocation for a story, a subsequent blocking `runRectification` for that same story dispatches its strategy up to the full per-strategy cap.
- AC-4.3 `[integration]` For a story whose first rectification cycle runs two iterations in which a finding with source `"gate"` is present before and absent after the first iteration and present again after the second, and whose second cycle runs one iteration with no such reappearance, the runtime's `rectificationOscillations` entry for that story equals 1.
- AC-4.4 `[integration]` After a second `runRectification` invocation that runs one iteration for a story whose first invocation ran two, the rectification phase output reports an `iterationCount` of 1.
- AC-4.5 `[integration]` With `storyScopedFixBudget` enabled and one shared runtime, exhausting the budget for story `"US-001"` leaves a subsequent `runRectification` for story `"US-002"` dispatching fix operations normally.
- AC-4.6 `[integration]` With `storyScopedFixBudget` enabled and a runtime on which `storyFixHistory` is absent, `runRectification` completes without throwing and dispatches fix operations as it does today.
- AC-4.7 `[integration]` With `storyScopedFixBudget` enabled and `phaseTelemetry` absent from the context, two successive `runRectification` invocations for one story share a budget, so the second dispatches no fix operation once the first has exhausted the per-strategy cap.
- AC-4.8 `[integration]` With `storyScopedFixBudget` enabled and `ctx.storyId` absent, `runRectification` returns without recording any state in the runtime's `storyFixHistory`.

**Verification note.** This spec adds no removals, so there is no terminal-cleanup story. The repo's static gate for the type and config changes is `bun run typecheck`; lint is `bun run lint`.

**Test-hygiene note.** Every test that constructs a runtime via `makeTestRuntime` or `makeMockRuntime` must collect it and close it in an `afterEach`; this is enforced by `scripts/check-runtime-cleanup.sh` as part of `bun run lint`. Unit tests mirror source paths (`test/unit/findings/story-fix-history.test.ts`); cross-module tests belong under `test/integration/`.

<!-- spec-writing: completed-through-phase-6 -->
