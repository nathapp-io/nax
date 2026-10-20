# SPEC: Port the story workflow onto the step graph (G3)

## Summary

Run the story workflow on the G1 step graph engine (`runStepGraph`, `packages/nax/src/step-graph/`) instead of
the hand-written loop in `runStoryLoop` (`src/workflow/story-loop.ts`). The loop's five phases (the first
implement turn with its no-work ladder, one evaluate pass of gates -> review -> suite, the residual
adjudication, one fix round, and the close) become the nodes of one graph value, `STORY_GRAPH`, and the
`for (;;)` loop with its `break`s becomes transitions on that graph. The story loop's two cost checks move into
the graph's `costStop`. The behaviour of a real story does not change: the same seam calls in the same order,
the same `sink.update` patches, the same ledger lines, the same `workflow` log lines, and the same
`StoryLoopOutcome`.

## Motivation

The step graph arc (master plan R1) builds a declarative step graph first, so that `nax bot review` and
`nax bot fix` can later run the workflow's steps against any PR. G0 recorded what the story loop does today as
golden traces (`test/fixtures/workflow-equivalence/story/`, #2618), G1 added the engine (#2619), and G2 moved the
feature workflow onto it (#2620). The story loop is the last workflow machine still written as a hand-rolled
loop. Until it runs on the graph, its transitions stay buried in `break` statements and in-place `LoopState`
mutation, and G4 (steps that run with a narrow step context) has no node boundaries to split along.

## Design

### Approach

A mechanical port, not a redesign. Every helper keeps its body: the same seam calls, ledger writes,
`sink.update` patches and `startStep` lines on stage `workflow`, in the same order. What changes:

1. The loop's in-memory state, today the `LoopState` class plus the locals `firstAfterResume` and `rulings`,
   becomes the graph state `StoryLoopState` (below), threaded through the engine.
2. The code between two decision points becomes one node's `run` function, returning
   `StepResult<StoryLoopState>`: a patch of the state keys it changed, and an exit label where it chose between
   destinations.
3. `runStoryLoop` builds the initial state and makes one `_storyLoopDeps.runStepGraph(...)` call.

The story loop differs from the feature workflow in three ways that shape the wiring, all of them pinned by
the G0 story goldens, which trace every `steps.costExceeded` call and every `sink.update` patch:

- **Persistence stays where it is.** The story record (`WorkflowStoryRecord`) is written by patches at fixed
  points inside the phases, not once per step. The nodes keep writing exactly those patches through
  `env.sink.update`. `StoryLoopState` is never persisted: the engine's `persist` hook is a no-op, and a resumed
  story is rebuilt from `env.resume` exactly as `LoopState`'s constructor rebuilds it today. A per-node persist
  would add `sink.update` calls the goldens do not have.
- **The cost limit is checked at two points, not before every agent step.** Today the loop calls
  `env.steps.costExceeded()` at the top of each evaluate pass and again before each fix round, and never before
  the first implement turn or the residual adjudication. The engine's own rule (ask `options.costExceeded()`
  before every `agent` node) would add calls. So the graph's `costStop` holds the story rule and reads
  `env.steps.costExceeded()` itself for the `evaluate` and `fix` nodes only, and `runStoryLoop` passes
  `costExceeded: () => true`, which hands every `agent` node to that `costStop` without a seam call of its own.
- **There is no abort check inside the loop.** The pipeline stage checks `ctx.abortSignal` after the loop
  returns (`src/workflow/stage.ts`). `runStoryLoop` passes `aborted: () => false` and no `onAbort`.

`runStoryLoop` keeps its name, its signature (`(env: StoryLoopEnv) => Promise<StoryLoopOutcome>`) and its
module, so `workflowStage`, `recordStoryTrace` (`test/helpers/workflow-story-trace.ts`) and every existing test
reach the ported code unchanged.

### State

```ts
// src/workflow/story-loop.ts
export type StoryNode = "implement" | "evaluate" | "residual" | "fix" | "close" | "done";

/** The story loop's working state; in memory only, never persisted (the record is written by patches). */
export interface StoryLoopState extends GraphState<StoryNode> {
  readonly round: number;
  readonly reviewed: boolean;
  readonly unreviewed: boolean;
  readonly nextId: number;
  readonly reviewOpen: readonly WorkflowFinding[];
  readonly pendingSession: readonly WorkflowFinding[];
  readonly concerns: readonly string[];
  readonly questions: number;
  readonly deferredMinors: number;
  readonly fixBase?: string;
  readonly gates?: GateRunResult;
  readonly suite?: GateRunResult;
  readonly suiteThisIteration: boolean;
  /** Set by the graph's cost stop; read by `close` through `deriveEndState`. */
  readonly costLimited: boolean;
  /** The first fix round after a resume runs fresh. */
  readonly firstAfterResume: boolean;
  /** The current evaluate pass's open findings (gate, review or suite, plus pending session findings). */
  readonly open: readonly WorkflowFinding[];
  readonly rulings: readonly WorkflowRuling[];
  /** Set by `implement` when the no-work ladder closes the story; `close` uses it instead of `deriveEndState`. */
  readonly closeAs?: { readonly state: WorkflowEndState; readonly reason: string };
  /** Set by `close`; what `runStoryLoop` resolves to. */
  readonly outcome?: StoryLoopOutcome;
}
```

`initialStoryState(env)` builds the starting state with the same rules `LoopState`'s constructor uses today:
`round`, `reviewed`, `unreviewed`, `deferredMinors` and `fixBase` from `env.resume` (defaults `0`, `false`,
`false`, `0`, absent), `nextId` from `env.resume.nextFindingId` (default `1`), `reviewOpen` from the resume
record's `openFindings` filtered to kinds `spec` and `quality`, `pendingSession`, `concerns`, `open` and
`rulings` empty, `questions` `0`, `suiteThisIteration` and `costLimited` `false`, `firstAfterResume` equal to
`env.resume !== null`, `timings` `{}`, and `step` `"implement"` for a fresh story (`env.resume === null`) or
`"evaluate"` for a resumed one. A resumed story skips the first implement turn, as `openStory` does today.

A node never mutates the state object it is handed (the engine's contract). Inside one node the helpers may
keep working on a node-local mutable copy: today's `LoopState` class, moved to `story-steps.ts` and built from
the graph state at the start of the node instead of from `env.resume`. The node then returns every key it
declares in `produces`, read off that copy, as its patch (so a key whose value is unchanged is restated, and a
key the copy holds as `undefined`, such as a retired `fixBase`, is cleared). The helpers keep their bodies and
their `s: LoopState` parameter. The copy gains no fields: it holds what `LoopState` holds today, with its
`costStop` field read from the state's `costLimited`, while `open`, `rulings`, `firstAfterResume` and `closeAs`
are node locals read from and patched onto the graph state directly.

### File layout

`story-loop.ts` splits into three files, each under the 600-line limit `check:file-sizes` enforces:

| File | Holds |
|---|---|
| `src/workflow/story-loop.ts` | `StoryLoopSteps`, `StoryLoopSink`, `StoryLoopEnv`, `StoryLoopOutcome`, `StoryNode`, `StoryLoopState`, `_storyLoopDeps`, `runStoryLoop` (the wiring below), and a re-export of `turnLabel` from `story-steps.ts`, so `stage-env.ts` and `story-loop.test.ts` keep importing it from `./story-loop`. |
| `src/workflow/story-steps.ts` (new) | The five node functions (`implementStep`, `evaluateStep`, `residualStep`, `fixStep`, `closeStep`), `initialStoryState`, and everything else moved from `story-loop.ts`: the `LoopState` class and the `TurnOrigin` interface (the helpers' working copy, see § State), the helpers `implementTurn`, `absorbTurn`, `recordConcern`, `review`, `reReviewStatus`, `reReviewSummary`, `deferMinors`, `evaluate`, `redGateNames`, `closeLoop`, `NO_MIRROR`, `isBlocking`, the exported constants `WARM_ROUND_CAP` and `MAX_IMPLEMENTER_QUESTIONS` (no module outside the story loop imports them, so they are not re-exported), and `turnLabel`. Imports from `story-loop.ts` are type-only. |
| `src/workflow/story-graph.ts` (new) | `STORY_GRAPH` and its `costStop`. |

Import direction: `story-loop.ts` -> `story-graph.ts` -> `story-steps.ts` (values), `story-loop.ts` ->
`story-steps.ts` (values: `initialStoryState` and the re-exports), and `story-steps.ts` -> `story-loop.ts`
(types only), so `check:import-cycles` sees no runtime cycle. `no-work.ts` keeps its type-only import of
`StoryLoopEnv` from `./story-loop`. The workflow imports the engine through its barrel, `@/step-graph`.
`STORY_GRAPH` is declared with an explicit type,
`export const STORY_GRAPH: StepGraph<StoryLoopState, StoryLoopEnv, StoryNode> = defineStepGraph({ ... })`, for
the same reason G2 annotates `FEATURE_GRAPH`: without it `kind` and `start` widen to `string`. Tests reach
`STORY_GRAPH.costStop` with `?.(...)` and nodes through a small accessor that throws on a missing node, never a
non-null `!` (a biome error) or a cast.

### Node table

`STORY_GRAPH`: `start` `"implement"`, `end` `["done"]`, `costStopProduces` `["costLimited"]`. No node declares
`needs` and the graph declares no `inputs` (see Out of Scope). No node declares `commits`: the story loop keeps
no `lastHead`, and `runStoryLoop` passes no `readHead`.

| Node | `kind` | Body (today's code) | `produces` |
|---|---|---|---|
| `implement` | `agent` | `openStory` up to and including `absorbTurn`: `sink.update({ phase: "implement" })`, the first implementer turn, `runNoWorkLadder`, `absorbTurn` | `pendingSession`, `nextId`, `questions`, `concerns`, `closeAs` |
| `evaluate` | `agent` | one loop pass up to the two decisions: `evaluate`, the open list with `pendingSession` folded in and cleared, and the `sink.update` of `openFindings`, `fixBase`, `reviewed`, `unreviewed`, `nextFindingId`, `deferredMinors` | `suiteThisIteration`, `gates`, `suite`, `nextId`, `reviewed`, `unreviewed`, `deferredMinors`, `reviewOpen`, `fixBase`, `open`, `pendingSession` |
| `residual` | `agent` | the `round >= maxFixRounds` branch: `sink.update({ phase: "residual" })`, the full suite when the gates were green and the suite did not run this pass, `adjudicateResidual` over the non-gate open items | `suite`, `rulings` |
| `fix` | `agent` | one fix round: `round` incremented, `fresh` (`round > warm` or the first round after a resume), `firstAfterResume` cleared, `fixBase` read from `head()` when review findings are open and no base is held, the `fixRound` ledger line, `sink.update({ phase: "fix", round, fixBase })`, the fix turn, `absorbTurn` | `round`, `firstAfterResume`, `fixBase`, `pendingSession`, `nextId`, `questions`, `concerns` |
| `close` | `pure` | `deriveEndState` (or `closeAs` when set) then `closeLoop` | `outcome` |

`close` writes only through the sink (the record patch and the end ledger line); it makes no agent, git, gate
or forge call, so its kind is `pure`. Each `produces` list is every state key the node's code can change.

### Transitions

| Node | Exit | Returned when (today's code path) | To |
|---|---|---|---|
| `implement` | `worked` | the no-work ladder did not close the story | `evaluate` |
| `implement` | `no-work` | the ladder closed it (`result.closed`); the patch sets `closeAs` to `{ state: "complete-gate-open", reason: "no work produced" }` | `close` |
| `evaluate` | `clean` | the open list is empty | `close` |
| `evaluate` | `capped` | findings are open and `round >= maxFixRounds` | `residual` |
| `evaluate` | `open` | findings are open and a fix round is left | `fix` |
| `residual` | — | always | `close` |
| `fix` | — | always | `evaluate` |
| `close` | — | always | `done` |

### Cost stop

`STORY_GRAPH.costStop(node, state, env)`. The engine calls it for every `agent` node, because `runStoryLoop`
passes `costExceeded: () => true`. For `implement` and `residual` it resolves to `undefined` without calling
`env.steps.costExceeded`. For `evaluate` and `fix` it calls `env.steps.costExceeded()` once; when that returns
true it resolves to `{ patch: { costLimited: true }, to: "close" }`, otherwise to `undefined`. It writes no log
line, no ledger line and no record patch, as the loop's `break` writes none today.

### Wiring `runStoryLoop`

```ts
// src/workflow/story-loop.ts
/** The engine call, typed for this graph so a test can stub it without a cast. */
type RunStoryGraph = (
  graph: typeof STORY_GRAPH,
  env: StoryLoopEnv,
  state: StoryLoopState,
  hooks: StepGraphHooks<StoryLoopState, StoryNode>,
  options: StepGraphRunOptions<StoryNode>,
) => Promise<StoryLoopState>;

export const _storyLoopDeps: { runStepGraph: RunStoryGraph } = { runStepGraph };

export async function runStoryLoop(env: StoryLoopEnv): Promise<StoryLoopOutcome> {
  const final = await _storyLoopDeps.runStepGraph(
    STORY_GRAPH,
    env,
    initialStoryState(env),
    // The story record is written by the nodes' own sink patches; the graph state is never persisted.
    { persist: async () => {} },
    // The story loop has no abort check of its own, and its cost rule lives in STORY_GRAPH.costStop.
    { aborted: () => false, now: () => Date.now(), costExceeded: () => true },
  );
  if (final.outcome === undefined) {
    throw new NaxError("The story workflow ended without an outcome", "WORKFLOW_STORY_NO_OUTCOME", {
      stage: "workflow",
      storyId: env.storyId,
    });
  }
  return final.outcome;
}
```

`logScope` stays unset: the helpers write their own `workflow` lines, which the G0 goldens pin, and the engine
then logs nothing. `onStep`, `readHead` and `onAbort` are not passed. The shape above is the target; helper names
other than the ones it uses are the builder's.

### Integration

Symbols this feature changes. Each **Baseline** exists only to locate today's code and is never the interface to
implement; implement the **Target**.

- `runStoryLoop` in `src/workflow/story-loop.ts`.
  - Baseline: `async function runStoryLoop(env: StoryLoopEnv): Promise<StoryLoopOutcome>`, a `for (;;)` loop over
    a `LoopState`, with `openStory` before it and `closeLoop` after.
  - Target: same signature; the body is the `_storyLoopDeps.runStepGraph(...)` call above.
- The loop state.
  - Baseline: `class LoopState` (not exported) plus the locals `firstAfterResume` and `rulings` in `runStoryLoop`.
  - Target: `StoryLoopState` (exported type) threaded through the engine, built by `initialStoryState`.
- `WARM_ROUND_CAP`, `MAX_IMPLEMENTER_QUESTIONS`, `turnLabel`.
  - Baseline: declared and exported in `story-loop.ts`.
  - Target: declared and exported in `story-steps.ts`; only `turnLabel` is re-exported from `story-loop.ts`.
- `LoopState` and `TurnOrigin`.
  - Baseline: in `story-loop.ts`; `LoopState`'s constructor takes the resume record.
  - Target: in `story-steps.ts`; `LoopState` is built from a `StoryLoopState` (the node-local working copy).
- Removed from `story-loop.ts` with nothing in their place: `openStory` (its body is the `implement` node) and the
  loop body (the `evaluate`, `residual` and `fix` nodes).

Symbols read and not changed (verified on `main` @ `d46d5631d`):

- `runStepGraph`, `defineStepGraph`, `validateStepGraph`, and the types `GraphState`, `StepGraph`, `StepResult`,
  `CostStop`, `StepGraphHooks`, `StepGraphRunOptions` — `@/step-graph`.
- `StoryLoopSteps`, `StoryLoopSink`, `StoryLoopEnv`, `StoryLoopOutcome` — `src/workflow/story-loop.ts` (stay
  there, unchanged).
- `runNoWorkLadder` — `src/workflow/no-work.ts`; `deriveEndState` — `src/workflow/close.ts`;
  `adjudicateResidual` — `src/workflow/adjudicate.ts`; `absorbReReviewVerdict` —
  `src/workflow/re-review-absorb.ts`; `ledgerCannotVerify` — `src/workflow/gate-timing.ts`; `ledgerText` —
  `src/workflow/ledger.ts`; `startStep`, `describeFindings` — `src/workflow/run-log.ts`.
- `WorkflowStoryRecord`, `WorkflowFinding`, `WorkflowRuling`, `WorkflowEndState`, `GateRunResult` —
  `src/workflow/types.ts`.
- `workflowStage` and `_workflowStageDeps` — `src/workflow/stage.ts`; `buildStoryEnv` —
  `src/workflow/stage-env.ts` (both unchanged).
- `recordStoryTrace` — `test/helpers/workflow-story-trace.ts`; `makeStoryLoopHarness`, `storyLoopFixtures`,
  `failingReview` — `test/helpers/workflow-story-loop.ts`.
- The G2 precedent to mirror: `FEATURE_GRAPH` in `src/workflow/feature-graph.ts` and `_featureMachineDeps` /
  `runFeatureMachine` in `src/workflow/feature-machine.ts`.

### Equivalence evidence

The port is correct when today's tests pass without a single edit. In particular:

- `test/unit/workflow/story-loop-equivalence.test.ts` replays all twelve G0 story scenarios through
  `runStoryLoop` and compares them with the committed goldens in `test/fixtures/workflow-equivalence/story/`,
  including every `costExceeded` call and every `sink.update` patch.
- `story-loop.test.ts` (including the cost check before a fix round), `story-loop-log.test.ts`,
  `story-loop-no-work.test.ts`, `step-models-log.test.ts`, `stage.test.ts`, `stage-env.test.ts`,
  `adjudicate-close.test.ts` and `test/integration/workflow/stage-env-work-produced.test.ts` cover the paths the
  goldens do not.

None of those files and no golden changes (see `### Modifies`). A difference in any of them is a behaviour
change and a defect in the port, never a fixture to refresh.

### Failure Handling

| Situation | Behaviour |
|---|---|
| A seam call or helper throws inside a node | The error propagates out of `runStoryLoop` unchanged, and `workflowStage` closes the story gate-open as today. The engine catches nothing from a node. |
| The cost limit is reached at the top of an evaluate pass or before a fix round | The `costStop` routes to `close` with `costLimited` true; `close` derives `complete-gate-open` / `cost-limit` (as today). |
| The graph ends with no `outcome` on the final state | `runStoryLoop` rejects with `NaxError` `WORKFLOW_STORY_NO_OUTCOME`, context `{ stage: "workflow", storyId }`. Unreachable through `STORY_GRAPH` (`done` is reached only from `close`); it exists so the return needs no non-null assertion. |
| A node patches a key its node does not declare | Rejects with `STEP_GRAPH_UNDECLARED_OUTPUT`. A programming error the node table rules out; the existing suites exercise every patch. |

## Out of Scope

- Persisting the graph cursor or `StoryLoopState`, or adding `step` to `WorkflowStoryRecord`: the story record's shape and its write points stay as they are, and a resumed story starts at `evaluate` as today.
- Checking the cost limit before every agent node (the engine's default rule) in the story workflow: that would add cost checks before the first implement turn and the residual adjudication, a behaviour change; a later phase may adopt it deliberately.
- An abort check inside the story workflow: the pipeline stage keeps checking `ctx.abortSignal` after `runStoryLoop` returns.
- Splitting the no-work ladder (`runNoWorkLadder`), the implementer question loop in `absorbTurn`, or the warm/fresh round rule into graph nodes of their own: they stay inside the `implement` and `fix` nodes.
- Declaring `needs` on the story nodes and `inputs` on the graph: settled in G4, with the narrow step context.
- A narrow step context, a PR context, and running any story step outside a nax run: G4.
- Setting `logScope` for the story graph, or any new log line, ledger line, record field, record patch or outcome field: the port is behaviour-identical.
- Changing `workflowStage` (`src/workflow/stage.ts`), `buildStoryEnv` (`src/workflow/stage-env.ts`) or `runNoWorkLadder` (`src/workflow/no-work.ts`).
- Editing any existing test file or any golden under `test/fixtures/workflow-equivalence/`, or regenerating goldens with `NAX_UPDATE_WORKFLOW_GOLDEN=1`: the unchanged suites are the equivalence evidence.
- Changing the step graph engine (`src/step-graph/`) or the feature workflow files (`feature-graph.ts`, `feature-steps.ts`, `feature-machine.ts`).
- The deprecated `src/finish/` phase and pipeline mode: pipeline mode is frozen.
- The live-run check the master plan requires for G3 (one real `nax run` on the new build matching the old build): a manual step after merge, run only with the user's approval, not story work.
- Release notes, user docs and a release: the port has no user-visible surface.

## Stories

### US-001: Run the story workflow on the step graph
No dependencies. Workdir: packages/nax.

Moves the story loop's helpers from `src/workflow/story-loop.ts` into a new `src/workflow/story-steps.ts`,
expresses the loop as the five node functions and `initialStoryState` of Design § State, § Node table and
§ Transitions, adds `src/workflow/story-graph.ts` with `STORY_GRAPH` and the `costStop` of Design § Cost stop, and
replaces the body of `runStoryLoop` with the `_storyLoopDeps.runStepGraph` call of Design § Wiring. Moves
`LoopState` and `TurnOrigin` to `story-steps.ts`, deletes `openStory`, and re-exports `turnLabel` from
`story-loop.ts`. Tests in the new `test/unit/workflow/story-graph.test.ts` (the graph data, its cost stop and
its nodes) and `test/unit/workflow/story-loop-graph.test.ts` (the wiring and the initial state); every existing
test stays as it is.

Verification note: the removals are checked by the build and static gates (`bun run typecheck`,
`bun run check:all`, which runs `check:file-sizes` and `check:import-cycles`), and the existing suites listed in
Design § Equivalence evidence pass unchanged. `bun run test:coverage` covers the two new source files.

### Context Files

**US-001**
- `packages/nax/src/workflow/story-loop.ts`
- `packages/nax/src/step-graph/types.ts`
- `packages/nax/src/step-graph/run.ts`
- `packages/nax/src/workflow/feature-graph.ts`
- `packages/nax/test/helpers/workflow-story-loop.ts`

### Creates

**US-001**
- `packages/nax/src/workflow/story-steps.ts`
- `packages/nax/src/workflow/story-graph.ts`
- `packages/nax/test/unit/workflow/story-graph.test.ts`
- `packages/nax/test/unit/workflow/story-loop-graph.test.ts`

### Modifies

**US-001**
- `packages/nax/src/workflow/story-loop.ts` — `LoopState`, `TurnOrigin`, the helpers, `NO_MIRROR`, `isBlocking`, `WARM_ROUND_CAP`, `MAX_IMPLEMENTER_QUESTIONS` and `turnLabel` move to the new steps module (see Creates) and `turnLabel` is re-exported unchanged; `openStory` is deleted; the file gains the `StoryNode` and `StoryLoopState` types and `_storyLoopDeps`, keeps `StoryLoopSteps`, `StoryLoopSink`, `StoryLoopEnv`, `StoryLoopOutcome` and `runStoryLoop`, whose body becomes the `_storyLoopDeps.runStepGraph` call of Design § Wiring.

No existing test, test helper or golden changes. They reach the story workflow through `runStoryLoop`, `turnLabel` and the `StoryLoopEnv` seams, which keep their names, their module and their behaviour, so every existing assertion still holds.

### Seams

- `runStoryLoop` is the production entry point (`workflowStage` calls it through `_workflowStageDeps`). It
  reaches `runStepGraph` through `_storyLoopDeps`, which AC-11 to AC-14 stub; AC-19 runs it unstubbed.
- `STORY_GRAPH` and `initialStoryState` are created and consumed in this story; the G0 equivalence suite drives
  them through the real `runStepGraph` with no stub.

## Acceptance Criteria

### US-001

1. [unit] `STORY_GRAPH` is importable from `@/workflow/story-graph`, `validateStepGraph(STORY_GRAPH)` returns `{ errors: [] }`, its `start` is `"implement"` and its `end` is `["done"]`.
2. [unit] For each of the five nodes in Design § Node table, `STORY_GRAPH.nodes[<node>].kind` equals the table's `kind`, so the `agent` nodes are exactly `implement`, `evaluate`, `residual` and `fix`, and `close` is `pure`.
3. [unit] No node of `STORY_GRAPH` has `commits: true`.
4. [unit] For each node in Design § Node table, the set of keys in `STORY_GRAPH.nodes[<node>].produces` equals the table's `produces` set, and `STORY_GRAPH.costStopProduces` equals `["costLimited"]`.
5. [unit] For each node in Design § Transitions, `STORY_GRAPH.nodes[<node>].transitions`, read as an ordered list of `{ on, to }` pairs, equals the table's rows for that node in table order (`on` absent for the rows whose exit is `—`), and the node's `exits`, as a set, equal that node's exit labels (`exits` is absent on the nodes whose only row has exit `—`).
6. [unit] `STORY_GRAPH.costStop?.("evaluate", state, env)` with an `env.steps.costExceeded` spy that returns true resolves to `{ patch: { costLimited: true }, to: "close" }`, calls the spy exactly once, and calls neither `env.sink.update` nor `env.sink.ledger`.
7. [unit] `STORY_GRAPH.costStop?.("fix", state, env)` with an `env.steps.costExceeded` spy that returns false resolves to `undefined` and calls the spy exactly once.
8. [unit] `STORY_GRAPH.costStop?.("implement", state, env)` and `STORY_GRAPH.costStop?.("residual", state, env)` each resolve to `undefined` with an `env.steps.costExceeded` spy that returns true, and the spy is never called.
9. [unit] `initialStoryState(env)` for an env whose `resume` is `null` returns a state with `step` `"implement"`, `round` 0, `nextId` 1, `reviewOpen` empty, `firstAfterResume` false, `costLimited` false and `timings` `{}`.
10. [unit] `initialStoryState(env)` for an env whose `resume` record has `round` 2, `reviewed` true, `nextFindingId` 5, `deferredMinors` 1, `fixBase` `"b1"` and `openFindings` holding one `spec` finding `F1` and one `gate` finding `G1` returns a state with `step` `"evaluate"`, `round` 2, `reviewed` true, `nextId` 5, `deferredMinors` 1, `fixBase` `"b1"`, `reviewOpen` holding only `F1`, and `firstAfterResume` true.
11. [unit] With `_storyLoopDeps.runStepGraph` replaced by a spy (restored after each test, as `feature-machine-graph.test.ts` restores `_featureMachineDeps`) that resolves to a state whose `outcome` is `O`, `runStoryLoop(env)` on a fresh-story env calls the spy once with `STORY_GRAPH` and `env` as its first two arguments and a third argument whose `step` is `"implement"`, and resolves to `O`.
12. [unit] In that call, invoking the captured hooks' `persist(state)` resolves and calls neither `env.sink.update` nor `env.sink.ledger`, and the captured hooks have no `onStep`.
13. [unit] In that call, the captured options' `aborted()` returns false and `costExceeded()` returns true without calling `env.steps.costExceeded`, and the options' `logScope`, `readHead` and `onAbort` are undefined.
14. [unit] With `_storyLoopDeps.runStepGraph` replaced by a spy that resolves to a state with no `outcome`, `runStoryLoop(env)` rejects with a `NaxError` whose `code` is `WORKFLOW_STORY_NO_OUTCOME` and whose `context` is `{ stage: "workflow", storyId: env.storyId }`.
15. [unit] The `evaluate` node's `run` on a fresh harness env (`makeStoryLoopHarness({ review: [failingReview(1)] }, { maxFixRounds: 2 })`) and the state `{ ...initialStoryState(env), step: "evaluate", round: 2 }` resolves with `exit` `"capped"`, and the state object passed in is deep-equal before and after the call.
16. [unit] The `evaluate` node's `run` on its own fresh harness env (`makeStoryLoopHarness({ review: [failingReview(1)] }, { maxFixRounds: 2 })`) and the state `{ ...initialStoryState(env), step: "evaluate", round: 1 }` resolves with `exit` `"open"` and a patch whose `open` holds one finding with `severity` `"important"`.
17. [unit] The `implement` node's `run` on a harness env whose implementer replies carry no status block (`noStatusBlock` true) on every turn, the first turn and both restarts, and whose `steps.workProduced` resolves false on every call resolves with `exit` `"no-work"` and a patch whose `closeAs` is `{ state: "complete-gate-open", reason: "no work produced" }`.
18. [unit] The `close` node's `run` on a harness env and a state whose `closeAs` is `{ state: "complete-gate-open", reason: "no work produced" }`, `costLimited` false, `round` 0 and `rulings` empty resolves with a patch whose `outcome` is `{ state: "complete-gate-open", reason: "no work produced", rounds: 0, rulings: [], unreviewed: false }`, and calls `env.sink.update` once with a patch whose `state` is `"complete-gate-open"`, `reason` is `"no work produced"` and `phase` is `"closed"`.
19. [unit] `runStoryLoop` with the real engine (no stub) on a harness env (`makeStoryLoopHarness({ review: [failingReview(1)] }, { maxFixRounds: 2 })`) resolves to `{ state: "complete", reason: "clean", rounds: 1, rulings: [], unreviewed: false }`, and the harness recorded exactly two implementer turns, the first of kind `"implement"` and the second of kind `"fix"` with `round` 1.
20. [unit] The `residual` node's `run` on a harness env (`makeStoryLoopHarness({}, { maxFixRounds: 2 })` with `steps.fullSuite` wrapped in a spy) and the state `{ ...initialStoryState(env), step: "residual", round: 2, gates: storyLoopFixtures.GREEN, suiteThisIteration: false, open: [<one important spec finding F1>] }` calls `steps.fullSuite` exactly once, calls the advisor's `ruleResidual` once with items holding `F1`, and resolves with no `exit` and a patch whose `suite` is the full-suite result and whose `rulings` are what `adjudicateResidual` returned.
