# SPEC: Port the feature workflow onto the step graph (G2)

## Summary

Run the feature workflow on the G1 step graph engine (`runStepGraph`, `packages/nax/src/step-graph/`)
instead of the hand-written loop in `runFeatureMachine` (`src/workflow/feature-machine.ts`). The eight
feature steps (repo-gates, branch-review, branch-fix, branch-rereview, adjudicate, final-gates, gate-repair,
publish) become the nodes of one graph value, `FEATURE_GRAPH`. Each node declares its kind, whether it
commits, the record keys it produces and its exits, and the transitions that today hide inside the step
functions (each step function returns a patch that names the next step) become data on the graph. The
cost stop, the `lastHead` read after a committing step, the abort error, timings and persistence move to
the engine, wired to the same `FeatureEnv` seams. The behaviour of a real `nax run` does not change: same
step order, same ledger lines, same log lines, same feature record, same PR.

## Motivation

The step graph arc (master plan R1) builds a declarative step graph first, so that `nax bot review` and
`nax bot fix` can later run the review, fix, gate and publish steps against any PR. G0 recorded what the
feature workflow does today as golden traces (`test/fixtures/workflow-equivalence/feature/`, #2618), and G1
added the engine with no consumer (#2619). G2 is the engine's first consumer. Until the workflow runs on
the graph, the engine is unproven against real behaviour and the transitions stay buried in step code that
nothing else can reuse.

`feature-machine.ts` is 592 lines, close to the 600-line source limit that `check:file-sizes` enforces, so
the port also splits it by concern rather than growing it.

## Design

### Approach

A mechanical port, not a redesign. Every step function keeps its body: the same seam calls, ledger writes,
artifacts and `startStep` log lines on stage `workflow`, in the same order. Three things change in each
step function:

1. It no longer puts `step` in its patch. `step` is an engine key (`ENGINE_KEYS`), and the engine rejects a
   patch that names it.
2. Where it chose between destinations, it returns an exit label instead (table below). The graph's
   transitions map the label to the next node.
3. It returns `{ patch, exit? }` (`StepResult<WorkflowFeatureRecord>`) instead of a bare patch.

The loop's own policies move to the engine, which already reproduces them (G1 § Runner order):
abort before `sink.step`, `sink.step` before the cost stop, the cost stop only for agent work, `lastHead`
after a committing step that was not cost-stopped (an unreadable or empty HEAD keeps the old one),
`timings` accumulated from exactly two `now()` reads per step, `sink.update` after every step, and a final
`sink.step("done", record)`.

One accepted difference: the engine asks `options.costExceeded()` for every `agent` node before the graph's
`costStop` checks `hasAgentWork`, where today's `costStop` checks `hasAgentWork` first and the limit last. So
`env.costExceeded` is called on agent nodes that have no work. It is a pure read in production
(`costLimitReached` over the runtime's cost) and in the test harness, and no G0 trace records it, so the
extra calls are unobservable.

`runFeatureMachine` keeps its name, its signature and its module, so every caller and every existing test
reaches the ported code unchanged, including `recordFeatureTrace` (`test/helpers/workflow-trace.ts`), which
replays the G0 goldens through it.

### File layout

`feature-machine.ts` splits into three files, each under the 600-line limit:

| File | Holds |
|---|---|
| `src/workflow/feature-machine.ts` | `FeatureSteps`, `FeatureSink`, `FeatureFacts`, `FeatureEnv`, the `FeatureLimits` re-export, `_featureMachineDeps`, and `runFeatureMachine` (the wiring below). |
| `src/workflow/feature-steps.ts` (new) | The eight step functions and their helpers, moved from `feature-machine.ts` (`limitsOf`, `DEFAULT_LIMITS`, `costExceeded`, `assign`, `featureStep`, `NO_MIRROR` and the rest), plus `readHeadSoft`. It exports the step functions, `readHeadSoft`, and the helpers `feature-graph.ts` needs (`featureStep`, `NO_MIRROR`, `isFollowUpRound`, `roundTargets`, `fixNowMinors`). Imports from `feature-machine.ts` are type-only. |
| `src/workflow/feature-graph.ts` (new) | `FEATURE_GRAPH`, and the graph's `costStop` with its `hasAgentWork` check. |

Import direction: `feature-machine.ts` -> `feature-graph.ts` -> `feature-steps.ts` (values), and
`feature-steps.ts` -> `feature-machine.ts` (types only, so no runtime cycle for `check:import-cycles`). The
workflow imports the engine through its barrel, `@/step-graph`. `FEATURE_GRAPH` is declared with an explicit type,
`export const FEATURE_GRAPH: StepGraph<WorkflowFeatureRecord, FeatureEnv, FeatureStep> = defineStepGraph({ ... })`.
`defineStepGraph` returns its argument's own type, so without the annotation `kind` and `start` widen to
`string` and `runStepGraph` no longer fits the `RunFeatureGraph` type below. Because the annotation makes
`nodes` a `Partial` record and `costStop` optional, tests reach them with `FEATURE_GRAPH.costStop?.(...)` and a
small node accessor that throws on a missing node, never a non-null `!` (a biome error) or a cast. The step
functions keep their current
names (`repoGatesStep`, `branchReviewStep`, `branchFixStep`, `branchReReviewStep`, `adjudicateStep`,
`finalGatesStep`, `gateRepairStep`, `publishStep`).

### Node table

`FEATURE_GRAPH`: `start` `"repo-gates"`, `end` `["done"]`, `costStopProduces` `["costLimited"]`. No node
declares `needs` and the graph declares no `inputs` (see Out of Scope).

| Node | `kind` | `commits` | `produces` |
|---|---|---|---|
| `repo-gates` | `gate` | no | `repoGates`, `gateFindings`, `nextFindingId` |
| `branch-review` | `agent` | no | `reviewRan`, `cannotVerify`, `reviewUnread`, `reviewOpen`, `nextFindingId`, `minors`, `newMinors` |
| `branch-fix` | `agent` | yes | `fixBase`, `fixRan`, `fixRounds` |
| `branch-rereview` | `agent` | no | `reReviewSkipped`, `reviewOpen`, `nextFindingId`, `minors`, `newMinors`, `fixTargets` |
| `adjudicate` | `agent` | no | `rulings` |
| `final-gates` | `gate` | no | `finalGates`, `finalGateFindings`, `gateRepairFindings` |
| `gate-repair` | `agent` | yes | `gateRepairRounds` |
| `publish` | `forge` | yes | `outcome`, `ci`, `reasons`, `url`, `approval`, `ciDetail`, `storyStates`, `head`, `passed`, `flaggedDecisions`, `endedAt` |

The agent nodes are exactly today's `AGENT_STEPS` and the committing nodes are exactly today's
`COMMIT_STEPS`. Each `produces` list is every key the step function's patches can name today, other than
`step`, including the keys a patch states as `undefined` to clear them (`fixTargets`, `gateRepairFindings`,
`approval`, `ciDetail`).

### Transitions

A node with one destination declares no `exits` and one unconditional transition. A node that branches
declares the exit labels below and returns exactly one of them on every path; its transitions are one
`{ on, to }` per label, in this order.

| Node | Exit | Returned when (today's code path) | To |
|---|---|---|---|
| `repo-gates` | — | always | `branch-review` |
| `branch-review` | — | always (reviewed, no seed, or review not run) | `branch-fix` |
| `branch-fix` | `nothing-to-fix` | the round has no item to fix | `branch-rereview` |
| `branch-fix` | `capped` | the round is past `maxBranchFixRounds` | `adjudicate` |
| `branch-fix` | `no-base` | the fix base HEAD could not be read | `adjudicate` |
| `branch-fix` | `fixed` | the fix session ran, failed or not | `branch-rereview` |
| `branch-rereview` | `nothing-to-check` | no item to re-review, or no `fixBase` | `adjudicate` |
| `branch-rereview` | `skipped` | the re-review did not run | `adjudicate` |
| `branch-rereview` | `again` | the next round has targets | `branch-fix` |
| `branch-rereview` | `settled` | the re-review ran and no round follows | `adjudicate` |
| `adjudicate` | — | always | `final-gates` |
| `final-gates` | `reused` | no fix ran, so the repo gates are reused | `publish` |
| `final-gates` | `green` | the final gate run is green | `publish` |
| `final-gates` | `repair` | red, with findings, and a repair is allowed | `gate-repair` |
| `final-gates` | `red` | red with no repair | `publish` |
| `gate-repair` | — | always (repaired, capped, or nothing to repair) | `final-gates` |
| `publish` | — | always | `done` |

### Cost stop

`FEATURE_GRAPH.costStop(node, record, env)` replaces `costStop` in `feature-machine.ts`. The engine calls it
only for an `agent` node while `options.costExceeded()` returns true, so it no longer checks the limit
itself. It returns `undefined` when the node has no agent work (`hasAgentWork`, unchanged: the same
emptiness checks each step makes first). Otherwise it writes the same skipped line on stage `workflow`
(`startStep(FEATURE_SCOPE, node, { announce: false })` then `done("skipped (cost limit reached)")`), the same
ledger note `cost limit reached: <node> skipped` with `{ mirror: false }`, and returns
`{ patch: { costLimited: true }, to: "final-gates" }`.

`finalGatesStep`'s own check (`gateRepairAllowed` reads `env.costExceeded`) is part of the step body and
stays as it is.

### Wiring `runFeatureMachine`

```ts
// src/workflow/feature-machine.ts
/** The engine call, typed for this graph so a test can stub it without a cast. */
type RunFeatureGraph = (
  graph: typeof FEATURE_GRAPH,
  env: FeatureEnv,
  record: WorkflowFeatureRecord,
  hooks: StepGraphHooks<WorkflowFeatureRecord, FeatureStep>,
  options: StepGraphRunOptions<FeatureStep>,
) => Promise<WorkflowFeatureRecord>;

export const _featureMachineDeps: { runStepGraph: RunFeatureGraph } = { runStepGraph };

export function runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord> {
  return _featureMachineDeps.runStepGraph(
    FEATURE_GRAPH,
    env,
    env.record,
    { persist: (record) => env.sink.update(record), onStep: (step, record) => env.sink.step(step, record) },
    {
      aborted: () => env.aborted(),
      now: () => env.now(),
      costExceeded: () => env.costExceeded?.() === true,
      readHead: () => readHeadSoft(env),
      onAbort: (step) =>
        new NaxError("Run aborted during the feature workflow", "WORKFLOW_ABORTED", {
          stage: "workflow",
          storyId: "_run",
          step,
        }),
    },
  );
}
```

`logScope` stays unset: the step functions write their own `workflow` lines, which the G0 goldens pin, and
the engine then logs nothing. `readHeadSoft` (moved unchanged) catches a failed HEAD read, logs the
existing `warn` on stage `workflow` (`Could not read HEAD after a committing step; the record keeps the
last one`, `storyId` `_run`) and resolves `undefined`, so the engine's own `step-graph` warning never fires.
The shape above is the target; helper names other than the ones it uses are the builder's.

### Integration

Symbols this feature changes. Each **Baseline** exists only to locate today's code and is never the
interface to implement; implement the **Target**.

- `runFeatureMachine` in `src/workflow/feature-machine.ts`.
  - Baseline: `async function runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord>`, a
    `for (;;)` loop over the `STEPS` table with `applyPatch`, `costStop`, `COMMIT_STEPS` and `readHeadSoft`.
  - Target: same signature; the body is the one `_featureMachineDeps.runStepGraph(...)` call above.
- The eight step functions.
  - Baseline: `type StepFn = (env: FeatureEnv, rec: WorkflowFeatureRecord) => Promise<Patch>`, in
    `feature-machine.ts`, each patch naming `step`.
  - Target: `(env: FeatureEnv, rec: WorkflowFeatureRecord) => Promise<StepResult<WorkflowFeatureRecord>>`, in
    `feature-steps.ts`; no patch names `step`, and a branching step returns its exit label.
- The cost stop.
  - Baseline: `costStop(env, rec, step): Promise<Patch | undefined>`, which checks `AGENT_STEPS`,
    `hasAgentWork` and `env.costExceeded`, and returns `{ costLimited: true, step: "final-gates" }`.
  - Target: `FEATURE_GRAPH.costStop(node, rec, env): Promise<CostStop<WorkflowFeatureRecord, FeatureStep> | undefined>`,
    which checks `hasAgentWork` only and returns `{ patch: { costLimited: true }, to: "final-gates" }`.
- Removed from `feature-machine.ts` with nothing in their place: `applyPatch`, `STEPS`, `COMMIT_STEPS`,
  `AGENT_STEPS`, `StepFn` and the old `costStop` (the engine and `FEATURE_GRAPH` own these now).

Symbols read and not changed (verified on `main` @ `61c6419d2`):

- `runStepGraph`, `defineStepGraph`, `validateStepGraph`, and the types `StepGraph`, `StepResult`,
  `CostStop`, `StepGraphHooks`, `StepGraphRunOptions` — `@/step-graph`.
- `FeatureEnv`, `FeatureSteps`, `FeatureSink`, `FeatureFacts` — `src/workflow/feature-machine.ts` (stay
  there, unchanged).
- `WorkflowFeatureRecord`, `FeatureStep` — `src/workflow/types.ts`.
- `startStep`, `describeFindings` — `src/workflow/run-log.ts`; `ledgerText` — `src/workflow/ledger.ts`.
- `buildFeatureEnv` — `src/workflow/feature-env.ts`; `runWorkflowFeature` — `src/workflow/feature.ts`
  (calls `runFeatureMachine` through `_featureRunDeps`; both unchanged).
- `recordFeatureTrace`, `compareWithGolden` — `test/helpers/workflow-trace.ts`;
  `makeFeatureMachineHarness`, `featureMachineFixtures` — `test/helpers/workflow-feature-machine.ts`.

### Equivalence evidence

The port is correct when today's tests pass without a single edit. In particular:

- `test/unit/workflow/feature-machine-equivalence.test.ts` replays all G0 feature scenarios through
  `runFeatureMachine` and compares them with the committed goldens in
  `test/fixtures/workflow-equivalence/feature/`.
- `feature-machine.test.ts`, `feature-machine-fix-rounds.test.ts` (round caps, a lowered cap on resume,
  the gate-repair cap), `feature-machine-cost.test.ts`, `feature-machine-honesty.test.ts`,
  `feature-machine-log.test.ts`, `feature-machine-publish-record.test.ts`, `feature-events.test.ts` and
  `feature-flagged-decisions.test.ts` cover the paths the goldens do not.

None of those files and no golden changes (see `### Modifies`). A difference in any of them is a
behaviour change and a defect in the port, never a fixture to refresh.

### Failure Handling

| Situation | Behaviour |
|---|---|
| Abort observed before a step | Rejects with `NaxError` `WORKFLOW_ABORTED`, message `Run aborted during the feature workflow`, context `{ stage: "workflow", storyId: "_run", step }`; the step does not run (as today). |
| The record's `step` is not a feature step | Rejects with `NaxError` `STEP_GRAPH_UNKNOWN_NODE` before any seam call. Today the loop fails with a `TypeError` on the missing `STEPS` entry, and only after the abort check; no valid record reaches this path. |
| A step function throws | The error propagates unchanged and the last persisted record still names that step (as today). |
| A step patches a key its node does not declare | Rejects with `STEP_GRAPH_UNDECLARED_OUTPUT`. This is a programming error the node table rules out; the existing suites exercise every patch. |
| HEAD cannot be read after a committing step | `readHeadSoft` logs its existing `warn` on stage `workflow`, the record keeps the previous `lastHead`, and the run continues (as today). |

## Out of Scope

- The story workflow (`src/workflow/story-loop.ts`, `runStoryLoop`, `workflowStage`): G3 ports it.
- Declaring `needs` on the feature nodes and `inputs` on the graph: what each step reads is settled in G4, when steps take a narrow step context instead of the whole record and `FeatureEnv`.
- A narrow step context, a PR context, and running any feature step outside a nax run: G4.
- Setting `logScope` for the feature graph, or any new log line, ledger line, artifact, record field or record key order: the port is behaviour-identical.
- Changing `buildFeatureEnv` (`src/workflow/feature-env.ts`) or `runWorkflowFeature` (`src/workflow/feature.ts`): the `FeatureEnv` seams stay exactly as they are.
- Editing any existing test file or any golden under `test/fixtures/workflow-equivalence/`, or regenerating goldens with `NAX_UPDATE_WORKFLOW_GOLDEN=1`: the unchanged suites are the equivalence evidence.
- Changing the step graph engine (`src/step-graph/`): G2 consumes it as G1 shipped it.
- The deprecated `src/finish/` phase and pipeline mode: pipeline mode is frozen.
- `nax bot review` and `nax bot fix`: B2 and B3.
- The live-run check the master plan requires for G2 (one real `nax run` on the new build matching the old build): a manual step after merge, run only with the user's approval, not story work.
- Release notes, user docs and a release: the port has no user-visible surface.

## Stories

### US-001: Run the feature workflow on the step graph
No dependencies. Workdir: packages/nax.

Moves the eight step functions and `readHeadSoft` from `src/workflow/feature-machine.ts` into a new
`src/workflow/feature-steps.ts`, changes each to return a `StepResult` with no `step` key and the exit labels
of Design § Transitions, adds `src/workflow/feature-graph.ts` with `FEATURE_GRAPH` per Design § Node table,
§ Transitions and § Cost stop, and replaces the body of `runFeatureMachine` with the
`_featureMachineDeps.runStepGraph` call of Design § Wiring. Deletes `applyPatch`, `STEPS`, `COMMIT_STEPS`,
`AGENT_STEPS`, `StepFn` and the old `costStop` from `feature-machine.ts`. Tests in the new
`test/unit/workflow/feature-graph.test.ts` (the graph data and its cost stop) and
`test/unit/workflow/feature-machine-graph.test.ts` (the wiring); every existing test stays as it is.

Verification note: the removals are checked by the build and static gates (`bun run typecheck`,
`bun run check:all`, which runs `check:file-sizes` and `check:import-cycles`), and the existing suites listed
in Design § Equivalence evidence pass unchanged. `bun run test:coverage` covers the two new source files.

### Context Files

**US-001**
- `packages/nax/src/workflow/feature-machine.ts`
- `packages/nax/src/step-graph/run.ts`
- `packages/nax/src/step-graph/types.ts`
- `packages/nax/test/helpers/workflow-feature-machine.ts`
- `packages/nax/test/unit/workflow/feature-machine-equivalence.test.ts`

### Creates

**US-001**
- `packages/nax/src/workflow/feature-steps.ts`
- `packages/nax/src/workflow/feature-graph.ts`
- `packages/nax/test/unit/workflow/feature-graph.test.ts`
- `packages/nax/test/unit/workflow/feature-machine-graph.test.ts`

### Modifies

**US-001**
- `packages/nax/src/workflow/feature-machine.ts` — the step functions, `readHeadSoft` and their helpers move to the new steps module (see Creates); `applyPatch`, `STEPS`, `COMMIT_STEPS`, `AGENT_STEPS`, `StepFn` and the old `costStop` are deleted; the file keeps `FeatureSteps`, `FeatureSink`, `FeatureFacts`, `FeatureEnv`, the `FeatureLimits` re-export, and `runFeatureMachine`, whose body becomes the `_featureMachineDeps.runStepGraph` call of Design § Wiring.

No existing test, test helper or golden changes. They reach the workflow through `runFeatureMachine` and the `FeatureEnv` seams, which keep their names and behaviour, so every existing assertion still holds.

### Seams

- `runFeatureMachine` is the production entry point (`runWorkflowFeature` calls it through
  `_featureRunDeps`). It reaches `runStepGraph` through `_featureMachineDeps`, which AC-8 to AC-12 stub.
- `FEATURE_GRAPH` is created and consumed in this story; the G0 equivalence suite drives it through the real
  `runStepGraph` with no stub.

## Acceptance Criteria

### US-001

1. [unit] `FEATURE_GRAPH` is importable from `@/workflow/feature-graph`, `validateStepGraph(FEATURE_GRAPH)` returns `{ errors: [] }`, its `start` is `"repo-gates"` and its `end` is `["done"]`.
2. [unit] For each of the eight nodes in Design § Node table, `FEATURE_GRAPH.nodes[<node>].kind` equals the table's `kind`, so the `agent` nodes are exactly `branch-review`, `branch-fix`, `branch-rereview`, `adjudicate` and `gate-repair`.
3. [unit] The nodes of `FEATURE_GRAPH` with `commits: true` are exactly `branch-fix`, `gate-repair` and `publish`.
4. [unit] For each node in Design § Node table, the set of keys in `FEATURE_GRAPH.nodes[<node>].produces` equals the table's `produces` set, and `FEATURE_GRAPH.costStopProduces` equals `["costLimited"]`.
5. [unit] For each node in Design § Transitions, `FEATURE_GRAPH.nodes[<node>].transitions`, read as an ordered list of `{ on, to }` pairs, equals the table's rows for that node in table order (`on` absent for the rows whose exit is `—`), and the node's `exits`, as a set, equal that node's exit labels (`exits` is absent on the nodes whose only row has exit `—`).
6. [unit] `FEATURE_GRAPH.costStop?.("branch-fix", record, env)` on a record whose `reviewOpen` holds one important finding resolves to `{ patch: { costLimited: true }, to: "final-gates" }` and calls `env.sink.ledger` once with the text `cost limit reached: branch-fix skipped` and the options `{ mirror: false }` (the test passes an env whose `sink.ledger` is its own spy that records both arguments, since the harness's ledger keeps only the text).
7. [unit] `FEATURE_GRAPH.costStop?.("adjudicate", record, env)` on a record with an empty `reviewOpen` resolves to `undefined` and writes no ledger note, and `FEATURE_GRAPH.costStop?.("branch-review", record, env)` on a record whose `seed` is `null` does the same.
8. [unit] With `_featureMachineDeps.runStepGraph` replaced by a spy (restored after each test, as `hooks-workflow.test.ts` restores `_featureRunDeps`) that resolves to a record `R`, `runFeatureMachine(env)` calls the spy once with `FEATURE_GRAPH`, `env` and `env.record` as its first three arguments, and resolves to `R`.
9. [unit] In that call, invoking the captured hooks' `persist(record)` calls `env.sink.update` once with that record, and invoking `onStep("publish", record)` calls `env.sink.step` once with `"publish"` and that record.
10. [unit] In that call, the captured options' `aborted()` and `now()` return what `env.aborted()` and `env.now()` return, `costExceeded()` returns `false` for an env with no `costExceeded` and `true` for an env whose `costExceeded` returns true, and `logScope` is undefined.
11. [unit] In that call, the captured options' `onAbort("branch-fix")` returns a `NaxError` whose `code` is `WORKFLOW_ABORTED`, whose message is `Run aborted during the feature workflow`, and whose `context` is `{ stage: "workflow", storyId: "_run", step: "branch-fix" }`.
12. [unit] In that call, when `env.steps.head` rejects, the captured options' `readHead()` resolves to `undefined` and one `warn` log entry on stage `"workflow"` has the message `Could not read HEAD after a committing step; the record keeps the last one` with `data.storyId` `"_run"`.
13. [unit] `runFeatureMachine` on a harness env (`makeFeatureMachineHarness`) whose record has `step` `"bogus"` (built as `"bogus" as string as FeatureStep`) rejects with a `NaxError` whose `code` is `STEP_GRAPH_UNKNOWN_NODE`, and no `env.steps` method and no `env.sink` method is called.
14. [unit] A `runFeatureMachine` run on a harness env whose branch review leaves one important finding and whose `env.steps.head` is replaced by one that rejects on every call reaches `done` with `env.steps.branchFix` never called and the ledger holding `branch fix skipped: HEAD could not be read` (the `no-base` exit), and its HEAD-read failures produce `warn` entries on stage `"workflow"` only, with no log entry at all on stage `"step-graph"`.
15. [unit] A `runFeatureMachine` run on a harness env whose record starts at `step` `"branch-fix"` with `fixRan` true, `fixRounds` 1, `fixBase` `"b1"`, `lastHead` `"h0"`, `fixTargets` naming one finding in `reviewOpen`, and an `env.steps.head` that rejects on every call (default limits, so `maxBranchFixRounds` is 2) calls `env.steps.branchFix` once (round 2 reuses `fixBase`, so it reads no HEAD for the base), reaches `done`, and every record passed to `env.sink.update` has `lastHead` `"h0"`, with no log entry on stage `"step-graph"`.
