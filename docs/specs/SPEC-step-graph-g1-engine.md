# SPEC: Step graph engine (G1)

## Summary

Add a generic step graph engine as a new module, `packages/nax/src/step-graph/`. A graph is data: named
nodes, each with a kind (`agent | gate | git | forge | pure`), the record keys it needs and produces, whether
it can commit, a run function, and an ordered list of transitions with optional exit labels and guards. One
runner, `runStepGraph`, owns what `runFeatureMachine` (`src/workflow/feature-machine.ts`) owns today. It
persists the record after every step, resumes at the node the record names, honours abort, applies a
cost-stop rule to agent nodes past the cost limit, records `lastHead` after committing nodes, accumulates
per-node timings, and can log step start and done lines. Nothing in nax uses the engine yet. G2 ports the
feature workflow onto it and G3 ports the story workflow.

## Motivation

Workflow mode keeps its transitions inside the step functions. Each step in `feature-machine.ts` returns a
patch that names the next step, and `runFeatureMachine` (`feature-machine.ts:563`) is a hand-written loop
around a `STEPS` table. Steps that only make sense inside a nax run cannot be reused elsewhere. That blocks
`nax bot review` and `nax bot fix`, which must run the review, fix, gate and publish steps against any PR.
The arc's master plan (ruling R1) builds the step graph first: G1 is the engine and its tests only, G2 and G3
port the two workflows with no behaviour change, and G4 splits the step context from the run.

The engine has to reproduce `runFeatureMachine`'s loop exactly, so that the G2 port can pass the G0 golden
traces (`test/fixtures/workflow-equivalence/`, merged in #2618). That fixes the order in which the runner
calls its environment. The order is pinned below, and the ACs pin it.

## Design

### Approach

A deterministic runner over a typed, validated graph value. No LLM, no I/O beyond logging: the runner calls only
what the caller injects (node run functions, guards, the cost-stop hook, the hooks and the run options).

The engine needs nothing beyond `@/errors` (`NaxError`), `@/logger` (`getSafeLogger`) and `@/log-format`
(`formatDuration`). It never imports from `src/workflow/`: G2 makes the workflow import the engine, and the
reverse edge would close an import cycle that `check:import-cycles` counts.

`check:complexity` caps every function at cognitive complexity 20 (`STRICT_LIMIT`,
`packages/repo-tooling/scripts/check-complexity.ts:74`), and a new file has no baseline entry. `runStepGraph`
therefore stays a short loop over small helpers (for example: one iteration, patch checking, transition choice,
the HEAD read), the way `runFeatureMachine` keeps its logic in `costStop`, `readHeadSoft` and `applyPatch`.
The helper names are the builder's.

### Integration

Read-only symbols (verified on `main` @ `7aba31f5f`; no symbol below is changed by this spec):

- `NaxError(message: string, code: string, context?: Record<string, unknown>)` — `@/errors` (re-exported
  from `@nathapp/nax-agent/internal`). Its `context` always carries `stage` (`.nax/rules/error-handling.md`).
- `getSafeLogger(): Logger | null` — `@/logger`. Calls are `info(stage, message, data)` /
  `warn(stage, message, data)`, and `storyId` must be the first data key (`check:logger-storyid`).
- `formatDuration(durationMs: number): string` — `@/log-format`.
- Pattern to mirror, not to change: `runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord>` and
  its helpers in `src/workflow/feature-machine.ts`:
  - `applyPatch` (`:105`) applies a patch key by key, and a key the patch states as `undefined` is deleted;
  - `costStop` (`:542`) skips an agent step past the cost limit;
  - `COMMIT_STEPS` (`:550`) and `readHeadSoft` (`:460`) record `lastHead`;
  - the loop (`:563`) checks abort, calls `sink.step`, times the step and calls `sink.update` after every step.
- `WorkflowFeatureRecord` (`src/workflow/types.ts:196`) already has the three engine-owned fields this spec
  names: `step`, `timings: Readonly<Record<string, number>>` and `lastHead?: string`.

The engine copies `applyPatch`'s rule rather than importing it. Deleting the copy in `feature-machine.ts` is
G2's work.

### Types (worked skeleton)

The engine has no precedent in nax, so the shape it must reach is given here. Exact generic spellings are the
builder's; the names, fields and semantics are the contract.

```ts
// src/step-graph/types.ts
export type StepKind = "agent" | "gate" | "git" | "forge" | "pure";

/** The engine-owned fields every graph record carries. */
export interface GraphState<N extends string> {
  readonly step: N;                                  // cursor: the next node to run, or an end id
  readonly timings: Readonly<Record<string, number>>; // ms per node id, accumulated
  readonly lastHead?: string;                        // HEAD after the last committing node
}

/** The record keys the engine writes itself; no node may declare or patch them. */
export const ENGINE_KEYS = ["step", "timings", "lastHead"] as const;

export interface StepResult<S> {
  readonly patch: Partial<S>;   // applied key by key; an `undefined` value deletes the key
  readonly exit?: string;       // optional label the transitions can match; never persisted
}

export interface StepTransition<S, E, N extends string> {
  readonly to: N;
  readonly on?: string;                              // matches StepResult.exit
  readonly when?: (state: S, env: E) => boolean;     // evaluated on the post-patch state
}

export interface StepNode<S, E, N extends string> {
  readonly kind: StepKind;
  readonly commits?: boolean;
  readonly needs?: readonly string[];
  readonly produces: readonly string[];
  readonly exits?: readonly string[];
  readonly transitions: readonly StepTransition<S, E, N>[];
  run(env: E, state: S): Promise<StepResult<S>>;
}

export interface CostStop<S, N extends string> {
  readonly patch: Partial<S>;
  readonly to: N;
}

export interface StepGraph<S extends GraphState<N>, E, N extends string> {
  readonly start: N;
  readonly end: readonly N[];
  readonly inputs?: readonly string[];               // keys the initial record supplies
  readonly nodes: Readonly<Partial<Record<N, StepNode<S, E, N>>>>;
  /** The keys a `costStop` patch may set; required when `costStop` is defined. */
  readonly costStopProduces?: readonly string[];
  /** Asked only for an agent node while the cost limit is exceeded; undefined = run the node. */
  costStop?(node: N, state: S, env: E): Promise<CostStop<S, N> | undefined>;
}

export interface StepGraphHooks<S, N extends string> {
  persist(state: S): Promise<void>;
  onStep?(node: N, state: S): void;
}

export interface StepGraphRunOptions<N extends string> {
  aborted(): boolean;
  now(): number;
  costExceeded?(): boolean;
  readHead?(): Promise<string | undefined>;
  onAbort?(node: N): Error;
  logScope?: string;                                 // set = the engine logs step lines (below)
}

// src/step-graph/validate.ts
export function validateStepGraph(graph): { errors: string[] };
export function defineStepGraph(graph): typeof graph; // throws NaxError STEP_GRAPH_INVALID

// src/step-graph/run.ts
export function runStepGraph(graph, env, state, hooks, options): Promise<S>;
```

`src/step-graph/index.ts` is the barrel. It exports every name above; `runStepGraph` joins it in US-002.

### Validation rules

`validateStepGraph(graph)` returns `{ errors }` and lists every violation, not only the first. Each message
names the offending node, key or id:

1. `start` is a node id or an end id.
2. Every transition `to` is a node id or an end id.
3. Every node has at least one transition.
4. No end id is also a node id.
5. A transition's `on` is one of its node's `exits`.
6. Every key in a node's `needs` is an engine key, in `graph.inputs`, in some node's `produces`, or in
   `graph.costStopProduces`.
7. No node's `produces`, and not `graph.costStopProduces`, contains an engine key (`step`, `timings`,
   `lastHead`).
8. A graph with any `agent` node defines `costStop`, and a graph that defines `costStop` defines
   `costStopProduces` (an empty list counts as defined).

Every `STEP_GRAPH_*` error the engine throws carries `context.stage` `"step-graph"`.

`defineStepGraph(graph)` returns the graph unchanged when there are no errors. Otherwise it throws
`NaxError` with code `STEP_GRAPH_INVALID`, `context.stage` `"step-graph"`, and a message listing every error.
`runStepGraph` runs the same validation before it calls anything and throws the same error.

### Runner order (the contract G2 depends on)

`runStepGraph(graph, env, state, hooks, options)` repeats, with `node = state.step`:

1. If `node` is an end id, leave the loop.
2. If `node` is not a node id, throw `NaxError` `STEP_GRAPH_UNKNOWN_NODE` (`context.stage` `"step-graph"`,
   `context.node`). This check comes before the abort check on purpose: `runFeatureMachine` would abort first
   and then fail on the unknown step with a `TypeError`, a path no valid record reaches.
3. If `options.aborted()` is true, throw `options.onAbort(node)` when given, else `NaxError`
   `STEP_GRAPH_ABORTED` with `context.stage` `"step-graph"` and `context.node`.
4. Call `hooks.onStep?.(node, state)`.
5. `started = options.now()`.
6. Cost stop: only when the node's kind is `agent`, `options.costExceeded` is given and returns true, call
   `graph.costStop(node, state, env)`. A returned `{ patch, to }` replaces steps 7-8: the node's `run` is not
   called, the patch is applied, the cursor becomes `to`, and no HEAD is read. Every key of that patch must be
   in `graph.costStopProduces`, else throw `STEP_GRAPH_UNDECLARED_OUTPUT`. A `to` that is neither a node id
   nor an end id throws `STEP_GRAPH_UNKNOWN_NODE`; an end id is valid and ends the run at the next iteration.
   `undefined` means run the node.
7. `result = await node.run(env, state)`. Every key of `result.patch`, including keys whose value is
   `undefined`, must be in the node's `produces`, else throw `NaxError` `STEP_GRAPH_UNDECLARED_OUTPUT`
   naming the node and key. A `result.exit` that is not in the node's `exits` (including any exit from a node
   with no `exits`) throws `STEP_GRAPH_UNDECLARED_EXIT`.
8. Choose the next node: apply the patch to `state`, then take the first of the node's transitions whose
   `on` is unset or equals `result.exit` (a transition with `on` never matches a result with no exit), and whose `when` is unset or returns true for the post-patch state
   and `env`. If none matches, throw `NaxError` `STEP_GRAPH_NO_TRANSITION` naming the node.
9. If the node has `commits: true`, was not cost-stopped and `options.readHead` is given, `head = await
   options.readHead()`. A non-empty string replaces `lastHead`. `undefined` or an empty string keeps the
   previous `lastHead`, as `runFeatureMachine` does. A throw keeps the previous `lastHead` and logs one `warn`
   on stage `"step-graph"`: `Could not read HEAD after committing node <node>; the record keeps the last one`,
   with data `{ storyId: logScope ?? "_run", node, error: <the error's message> }`. This catch is a backstop.
   G2 passes the workflow's own `readHeadSoft`, which catches, logs the workflow's existing warning and resolves
   `undefined`, so the G0 goldens keep that warning.
10. `elapsed = options.now() - started`. The new state is the patched state with `step` set to the next node,
    `lastHead` updated per step 9, and `timings[node]` increased by `elapsed`. Other `timings` entries are
    kept.
11. `await hooks.persist(newState)`.

After the loop, call `hooks.onStep?.(endId, state)` once and return `state`.

A throw at any step leaves the loop at once. `persist` is not called for the node that threw, so the last
persisted record still names that node as `step`, and a resume runs it again. A throw from `node.run`,
`graph.costStop`, a guard or `hooks.persist` propagates unchanged.

Every iteration calls `options.now()` exactly twice: once in step 5 and once in step 10. With `logScope`
unset, the engine adds no `now()` call and logs nothing except the step 9 warning.

### Step log lines

When `options.logScope` is set, the engine logs `info` lines on stage `"step-graph"` with data
`{ storyId: logScope, step: node, ... }`:

- between step 6 and step 7, so only a node that actually runs: message `<node> start`;
- at step 10, before `persist`: message `<node>: done  <formatDuration(elapsed)>` with `data.durationMs = elapsed`;
- for a cost-stopped node, instead of both: `<node>: skipped (cost limit reached)  <formatDuration(elapsed)>`
  with `data.durationMs = elapsed`.

The durations reuse the two `now()` reads of steps 5 and 10.

These lines are for graphs that have no step lines of their own, such as the later `nax bot` graphs. The
workflow's step functions write their own lines on stage `workflow` through `startStep`
(`src/workflow/run-log.ts`), with per-step labels, joiners, model names and result text, and the G0 goldens pin
them. G2 therefore leaves `logScope` unset, so a ported workflow run logs exactly what it logs today.

### Failure Handling

| Situation | Behaviour |
|---|---|
| Graph fails validation (`defineStepGraph` or `runStepGraph`) | Throws `NaxError` `STEP_GRAPH_INVALID` listing every error; nothing runs. |
| Record cursor names no node and no end id | Throws `STEP_GRAPH_UNKNOWN_NODE`; nothing runs, `persist` not called. |
| `costStop` returns an unknown `to` | Throws `STEP_GRAPH_UNKNOWN_NODE`; `persist` not called. |
| Abort observed at the top of an iteration | Throws `onAbort(node)` or `STEP_GRAPH_ABORTED`; the node does not run. |
| Patch key not in `produces` | Throws `STEP_GRAPH_UNDECLARED_OUTPUT`; `persist` not called. |
| Exit label not in `exits` | Throws `STEP_GRAPH_UNDECLARED_EXIT`; `persist` not called. |
| No transition matches | Throws `STEP_GRAPH_NO_TRANSITION`; `persist` not called. |
| Node `run` throws | The same error propagates; `persist` not called for that node. |
| `costStop` patch key not in `costStopProduces` | Throws `STEP_GRAPH_UNDECLARED_OUTPUT`; `persist` not called. |
| `readHead` throws after a committing node | Previous `lastHead` kept; one `warn` line; the run continues. |

## Out of Scope

- Any change to `src/workflow/` or any other existing nax module: G1 adds the engine and its tests only, and nothing in nax calls it yet.
- Porting `runFeatureMachine` or `runStoryLoop` onto the engine, deleting `applyPatch` from `feature-machine.ts`, and replaying the G0 goldens through the engine: those are G2 and G3.
- Importing anything from `src/workflow/` into `src/step-graph/`: G2 makes the workflow import the engine, so the reverse edge would close an import cycle.
- Mapping `WorkflowStoryRecord` (which has `phase`, not `step`) onto `GraphState`: G3 decides how the story loop's record maps to a graph state.
- A narrow step context type, a PR context, and running steps outside a nax run: those are G4.
- A step budget or loop limit (`maxSteps`): the workflow's loops are bounded by their round caps, which stay in the graphs' guards.
- Graphs authored in config files, and an LLM controller that picks steps: non-goals of the arc.
- Concurrency inside a graph (parallel nodes): every node runs one at a time.
- Pipeline mode and the deprecated `src/finish/` phase: pipeline mode is frozen.
- Release notes or user docs: the engine has no user-visible surface until G2.

## Stories

### US-001: Graph types and validation
No dependencies. Workdir: packages/nax.

Adds `src/step-graph/types.ts` with the types and `ENGINE_KEYS` from Design § Types, `src/step-graph/validate.ts`
with `validateStepGraph` and `defineStepGraph` implementing Design § Validation rules, and the barrel
`src/step-graph/index.ts`. Tests in `test/unit/step-graph/validate.test.ts`.

### US-002: Runner core loop
Depends on US-001. Workdir: packages/nax.

Adds `src/step-graph/run.ts` with `runStepGraph`, implementing Design § Runner order steps 1-5, 7, 8, 10 and 11,
and the end-of-loop `onStep` call. US-002 calls no cost-stop hook, never reads HEAD and logs no step lines;
US-003 adds those. Exports `runStepGraph` from the barrel. Tests in `test/unit/step-graph/run.test.ts`.

### US-003: Runner policies: cost stop, lastHead, step log lines
Depends on US-002. Workdir: packages/nax.

Extends `runStepGraph` with Design § Runner order step 6 (cost stop) and step 9 (`lastHead` after a committing
node), and with Design § Step log lines. Tests in `test/unit/step-graph/run-policies.test.ts`, a concern split from `run.test.ts`
(`<module>-<concern>.test.ts`) so each story owns its own test file and the policy tests stay together.

### Context Files

**US-001**
- `packages/nax/src/workflow/feature-machine.ts`
- `packages/nax/src/workflow/types.ts`
- `.nax/rules/error-handling.md`

**US-002**
- `packages/nax/src/step-graph/types.ts` — created by US-001, used here
- `packages/nax/src/step-graph/validate.ts` — created by US-001, used here
- `packages/nax/src/workflow/feature-machine.ts`
- `packages/nax/test/helpers/workflow-feature-machine.ts`

**US-003**
- `packages/nax/src/step-graph/run.ts` — created by US-002, extended here
- `packages/nax/src/workflow/feature-machine.ts`
- `packages/nax/src/workflow/run-log.ts`
- `packages/nax/test/unit/workflow/feature-machine-log.test.ts`

### Creates

**US-001**
- `packages/nax/src/step-graph/types.ts`
- `packages/nax/src/step-graph/validate.ts`
- `packages/nax/src/step-graph/index.ts`
- `packages/nax/test/unit/step-graph/validate.test.ts`

**US-002**
- `packages/nax/src/step-graph/run.ts`
- `packages/nax/test/unit/step-graph/run.test.ts`

**US-003**
- `packages/nax/test/unit/step-graph/run-policies.test.ts`

### Modifies

None. No file that exists on `main` today changes. US-001 creates the module. US-002 creates `run.ts` and adds one export line to `src/step-graph/index.ts`, which US-001 creates. US-003 extends `run.ts`, which US-002 creates, and keeps Design § Runner order steps 1-5, 7, 8, 10 and 11 in their order, so every US-002 AC still holds.

### Seams

- US-002 and US-003 call `validateStepGraph` from US-001 before running, and import every type from US-001's
  `src/step-graph/types.ts`.
- No production code calls `runStepGraph` or `defineStepGraph` in this spec. Their first production consumer
  is the G2 feature-workflow port, which carries the seam ACs for that wiring. The engine's own tests are its
  only callers here.

## Acceptance Criteria

### US-001

1. [unit] `defineStepGraph`, `validateStepGraph` and `ENGINE_KEYS` are importable from `@/step-graph`, the first two are functions, and `ENGINE_KEYS` equals `["step", "timings", "lastHead"]`.
2. [unit] `validateStepGraph` on a graph with nodes `a` (transition to `b`) and `b` (transition to end id `done`), `start` `a` and `end` `["done"]` returns `{ errors: [] }`.
3. [unit] `validateStepGraph` on a graph whose `start` is `"missing"` returns an error that names `missing`.
4. [unit] `validateStepGraph` on a graph where node `a` has a transition to `"nowhere"` returns an error that names both `a` and `nowhere`.
5. [unit] `validateStepGraph` on a graph where node `a` has an empty `transitions` list returns an error that names `a`.
6. [unit] `validateStepGraph` on a graph whose `end` list contains `"a"` while `a` is also a node id returns an error that names `a`.
7. [unit] `validateStepGraph` on a graph where node `a` declares `exits: ["ok"]` and has a transition with `on: "fail"` returns an error that names `a` and `fail`.
8. [unit] `validateStepGraph` on a graph where node `b` needs `"seed"`, `seed` is not in `graph.inputs`, and no node produces `seed` returns an error that names `b` and `seed`; the same graph with `inputs: ["seed"]` returns no error, and a node that needs `"lastHead"` with no input or producer for it returns no error.
9. [unit] `validateStepGraph` on a graph where node `a` lists `"timings"` in `produces` returns an error that names `a` and `timings`, and likewise for `"step"` and for `"lastHead"`.
10. [unit] `validateStepGraph` on a graph with an `agent`-kind node and no `costStop` returns an error that names that node; adding a `costStop` function with `costStopProduces: ["costLimited"]` removes the error.
11. [unit] `validateStepGraph` on a graph that defines `costStop` without `costStopProduces` returns an error; with `costStopProduces: ["costLimited"]`, a node that needs `"costLimited"` returns no error, and with `costStopProduces: ["step"]` it returns an error that names `step`.
12. [unit] `validateStepGraph` on a graph with both an unknown `start` and a node with no transitions returns two errors, one for each.
13. [unit] `defineStepGraph` returns the same graph object it was given when `validateStepGraph` reports no errors.
14. [unit] `defineStepGraph` on a graph with two validation errors throws a `NaxError` whose `code` is `STEP_GRAPH_INVALID`, whose `context.stage` is `"step-graph"`, and whose message contains both error texts.

### US-002

1. [unit] `runStepGraph` is importable from `@/step-graph` as a function, and on the three-node graph `a -> b -> c -> done` with initial `step` `a` calls the nodes' `run` functions in the order `a`, `b`, `c`, and resolves to a state whose `step` is `done`.
2. [unit] In that run, `hooks.persist` is called three times, once after each node, and the persisted states' `step` values are `b`, `c`, `done` in order.
3. [unit] In that run, `hooks.onStep` is called with `a`, `b`, `c` in order, each time before that node's `run` and with the state that node then receives, and finally once with `done` and the returned state.
4. [unit] `runStepGraph` with initial `step` `b` on the same graph calls `run` for `b` and `c` only, never for `a` (resume at the recorded node).
5. [unit] `runStepGraph` with initial `step` `done` calls no node's `run`, never calls `hooks.persist`, calls `hooks.onStep` once with `done`, and resolves to the initial state.
6. [unit] `runStepGraph` with initial `step` `"zzz"` (no node, no end id) rejects with a `NaxError` whose `code` is `STEP_GRAPH_UNKNOWN_NODE`, and no node's `run` and no `hooks.persist` call happen; it rejects with the same code when `options.aborted` returns true as well.
7. [unit] `runStepGraph` on a graph that fails validation rejects with a `NaxError` whose `code` is `STEP_GRAPH_INVALID` before calling `hooks.onStep`, any node's `run` or `hooks.persist`.
8. [unit] When a node's patch is `{ kept: 2, dropped: undefined }` on a state that has `dropped: 1` and `other: 3`, the persisted state has `kept` 2, `other` 3, and no `dropped` key at all.
9. [unit] A node whose transitions are `[{ to: "x", when: (s) => s.flag === true }, { to: "y" }]` and whose patch sets `flag: true` moves to `x`, because the guard sees the post-patch state; with a patch setting `flag: false` it moves to `y`.
10. [unit] A node with `exits: ["retry", "pass"]` and transitions `[{ on: "retry", to: "a" }, { on: "pass", to: "done" }]` moves to `a` when `run` returns `exit: "retry"` and to `done` when it returns `exit: "pass"`, and the persisted state has no key holding the exit label.
11. [unit] A node whose only transition is `{ to: "x", when: () => false }` makes `runStepGraph` reject with a `NaxError` whose `code` is `STEP_GRAPH_NO_TRANSITION` and whose message names the node, and `hooks.persist` is not called for that node.
12. [unit] A node with `produces: ["a"]` whose patch contains key `b` makes `runStepGraph` reject with a `NaxError` whose `code` is `STEP_GRAPH_UNDECLARED_OUTPUT` and whose message names the node and `b`, and the same happens when the patch states `b: undefined`.
13. [unit] A node with `exits: ["ok"]` whose `run` returns `exit: "other"` makes `runStepGraph` reject with a `NaxError` whose `code` is `STEP_GRAPH_UNDECLARED_EXIT`.
14. [unit] A node that declares no `exits` and whose `run` returns `exit: "ok"` makes `runStepGraph` reject with a `NaxError` whose `code` is `STEP_GRAPH_UNDECLARED_EXIT`.
15. [unit] A node with `exits: ["retry"]` and transitions `[{ on: "retry", to: "a" }, { to: "done" }]` whose `run` returns no exit moves to `done`, because a transition with `on` never matches a result with no exit.
16. [unit] A node with `exits: ["retry"]` and transitions `[{ on: "retry", when: () => false, to: "a" }, { to: "done" }]` whose `run` returns `exit: "retry"` moves to `done`, because a transition must pass both its `on` and its `when`.
17. [unit] When a transition's `when` guard throws an `Error("guard")`, `runStepGraph` rejects with that same error object and `hooks.persist` is not called for that node.
18. [unit] When node `b`'s `run` rejects with an `Error("boom")`, `runStepGraph` rejects with that same error object, and the last state passed to `hooks.persist` has `step` `b`.
19. [unit] When `options.aborted` returns true before node `b`, `runStepGraph` rejects with the error `options.onAbort("b")` returns, and neither `b`'s `run` nor `hooks.onStep("b", ...)` is called.
20. [unit] When `options.aborted` returns true and `options.onAbort` is not given, `runStepGraph` rejects with a `NaxError` whose `code` is `STEP_GRAPH_ABORTED`, whose `context.stage` is `"step-graph"` and whose `context.node` is the node that was about to run.
21. [unit] With `options.now` a counter that returns 0, 5, 10, 15 on successive calls, a two-node run persists `timings` `{ a: 5 }` after `a` and `{ a: 5, b: 5 }` after `b`, and `options.now` is called exactly four times.
22. [unit] A graph that visits node `a` twice (a guard sends `b` back to `a` once) persists a final `timings.a` equal to the sum of both visits' elapsed times, and keeps the `timings` entries the initial state already had for other node ids.
23. [unit] When `hooks.persist` rejects with an `Error("disk")` after node `a`, `runStepGraph` rejects with that same error object and node `b`'s `run` is never called.
24. [unit] After a three-node run, the initial state object passed to `runStepGraph` is deep-equal to a copy taken before the run, including its `timings` object, so the runner never mutates its input.

### US-003

1. [unit] An `agent` node run while `options.costExceeded` returns true, with `graph.costStopProduces` `["costLimited"]` and `graph.costStop` returning `{ patch: { costLimited: true }, to: "final" }`, is not run; the persisted state has `costLimited` true and `step` `final`, and `graph.costStop` was called with that node's id, the current state and `env`.
2. [unit] When `graph.costStop` returns `undefined` for an `agent` node while `options.costExceeded` returns true, that node's `run` is called and its transitions choose the next node.
3. [unit] A `gate`-kind node run while `options.costExceeded` returns true is run, and `graph.costStop` is not called.
4. [unit] With `options.costExceeded` not given, `graph.costStop` is never called and every `agent` node runs.
5. [unit] When `graph.costStop` returns `{ patch: {}, to: "nowhere" }`, `runStepGraph` rejects with a `NaxError` whose `code` is `STEP_GRAPH_UNKNOWN_NODE`, and `hooks.persist` is not called for that node.
6. [unit] When `graph.costStop` returns `{ patch: {}, to: "done" }` where `done` is an end id, the run persists a state whose `step` is `done`, runs no further node and resolves.
7. [unit] When `graph.costStop` returns a patch with key `other` while `graph.costStopProduces` is `["costLimited"]`, `runStepGraph` rejects with a `NaxError` whose `code` is `STEP_GRAPH_UNDECLARED_OUTPUT` and whose message names `other`, and `hooks.persist` is not called for that node.
8. [unit] A cost-stopped node still adds its elapsed time (between the two `options.now` reads) to `timings` under its own id.
9. [unit] For a node with `commits: true`, `options.readHead` is called once after the node's `run` and before the second `options.now` read, and the persisted state's `lastHead` is the string it returned.
10. [unit] When `options.readHead` resolves to `undefined` after a committing node, the persisted state keeps the `lastHead` the state had before that node, and the same holds when it resolves to an empty string.
11. [unit] When `options.readHead` rejects after a committing node, the run continues to the next node, the persisted state keeps the previous `lastHead`, and one `warn` log entry on stage `"step-graph"` has the message `Could not read HEAD after committing node <node>; the record keeps the last one` with the node id in place of `<node>`, and data whose `storyId` is `"_run"` (no `logScope` set), whose `node` is the node id and whose `error` is the rejection's message.
12. [unit] `options.readHead` is not called after a node without `commits: true`, nor after a committing `agent` node that was cost-stopped.
13. [unit] With `options.logScope` `"_run"` and `options.now` a counter, a node `a` that runs produces an `info` entry on stage `"step-graph"` with message `a start` before its `run`, then one with message `a: done  <formatDuration(elapsed)>`, both with `data.storyId` `"_run"` and `data.step` `"a"`, the second with `data.durationMs` equal to the elapsed time that `timings.a` gained.
14. [unit] With `options.logScope` set, a cost-stopped node produces exactly one `info` entry, with message `<node>: skipped (cost limit reached)  <formatDuration(elapsed)>`, and no `start` entry.
15. [unit] With `options.logScope` unset, a run with an `agent` node, a committing node whose `readHead` resolves, and a cost-stopped node produces no log entry on stage `"step-graph"`, and `options.now` is still called exactly twice per node.
