/**
 * `src/step-graph/run.ts` — `runStepGraph`, the deterministic resumable runner.
 *
 * The runner owns the loop and nothing else: it calls only what the caller injects (the
 * nodes' `run` functions, the guards, the hooks and the run options), so a run is
 * reproducible from the record it was handed. It imports nothing from `src/workflow/` —
 * G2 makes the workflow import the engine, and the reverse edge would close an import
 * cycle that `check:import-cycles` counts.
 *
 * Spec: docs/specs/SPEC-step-graph-g1-engine.md § Runner order (steps 1-11) and § Step log lines.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { formatDuration } from "@/log-format";
import { getSafeLogger } from "@/logger";
import type {
  CostStop,
  GraphState,
  StepGraph,
  StepGraphHooks,
  StepGraphRunOptions,
  StepNode,
  StepResult,
  StepTransition,
} from "./types";
import { defineStepGraph } from "./validate";

/** A refusal the engine owns, on the stage every `STEP_GRAPH_*` error carries. */
function refusal(message: string, code: string, node: string, extra: Record<string, unknown> = {}): NaxError {
  return new NaxError(message, code, { stage: "step-graph", node, ...extra });
}

/**
 * The node `id` names, or `undefined`.
 *
 * `id` is a persisted cursor, so it is runtime data. Ownership is checked *before* the read:
 * `graph.nodes[id]` on an inherited key would otherwise run that property's accessor — and its
 * error — before the runner could report `STEP_GRAPH_UNKNOWN_NODE`, and an inherited plain value
 * (`constructor`, `__proto__`, `toString`) would be taken for a node and fail later with a
 * `TypeError` on `node.run`. Only an *own* key of `graph.nodes` is a node id.
 */
function nodeAt<S extends GraphState<N>, E, N extends string>(
  graph: StepGraph<S, E, N>,
  id: N,
): StepNode<S, E, N> | undefined {
  return Object.hasOwn(graph.nodes, id) ? graph.nodes[id] : undefined;
}

/** Step 2: the node `id` names, or `STEP_GRAPH_UNKNOWN_NODE` when the graph has none. */
function nodeOf<S extends GraphState<N>, E, N extends string>(graph: StepGraph<S, E, N>, id: N): StepNode<S, E, N> {
  const node = nodeAt(graph, id);
  if (node === undefined) throw refusal(`step graph has no node "${id}"`, "STEP_GRAPH_UNKNOWN_NODE", id);
  return node;
}

/**
 * Step 6: a cost stop's `to` is a node id or an end id, like any other cursor the runner records —
 * an end id is valid and ends the run at the next iteration, anything else is unrecordable.
 */
function assertDestination<S extends GraphState<N>, E, N extends string>(graph: StepGraph<S, E, N>, to: N): void {
  if (graph.end.includes(to) || nodeAt(graph, to) !== undefined) return;
  throw refusal(`step graph has no node "${to}"`, "STEP_GRAPH_UNKNOWN_NODE", to);
}

/** Step 3: the run's abort — the caller's own error when it supplies one. */
function abortRefusal<N extends string>(id: N, onAbort: StepGraphRunOptions<N>["onAbort"]): Error {
  return onAbort?.(id) ?? refusal(`the run was aborted before node "${id}"`, "STEP_GRAPH_ABORTED", id);
}

/** The first key `patch` names that `declared` does not cover — a key stated as `undefined` included. */
function undeclaredKey(patch: Partial<unknown>, declared: ReadonlySet<string>): string | undefined {
  return Object.keys(patch).find((key) => !declared.has(key));
}

/** Step 7: every key a patch names is the node's to produce — a key stated as `undefined` too. */
function assertPatchDeclared<S, E, N extends string>(id: N, node: StepNode<S, E, N>, patch: Partial<S>): void {
  const undeclared = undeclaredKey(patch, new Set<string>(node.produces));
  if (undeclared === undefined) return;
  throw refusal(
    `node "${id}" patched "${undeclared}", which its produces does not declare`,
    "STEP_GRAPH_UNDECLARED_OUTPUT",
    id,
    { key: undeclared },
  );
}

/** Step 6: every key a cost stop's patch names is one the graph's `costStopProduces` declares. */
function assertCostStopDeclared<S extends GraphState<N>, E, N extends string>(
  id: N,
  graph: StepGraph<S, E, N>,
  patch: Partial<S>,
): void {
  const undeclared = undeclaredKey(patch, new Set<string>(graph.costStopProduces ?? []));
  if (undeclared === undefined) return;
  throw refusal(
    `the cost stop for node "${id}" patched "${undeclared}", which costStopProduces does not declare`,
    "STEP_GRAPH_UNDECLARED_OUTPUT",
    id,
    { key: undeclared },
  );
}

/** Step 7: a result's exit label is one the node declares; a node with no `exits` declares none. */
function assertExitDeclared<S, E, N extends string>(id: N, node: StepNode<S, E, N>, exit: string | undefined): void {
  if (exit === undefined || (node.exits ?? []).includes(exit)) return;
  throw refusal(
    `node "${id}" returned exit "${exit}", which its exits do not declare`,
    "STEP_GRAPH_UNDECLARED_EXIT",
    id,
    { exit },
  );
}

/**
 * What one iteration produced, short of the record: the patched state, the node it moves to, the
 * time the node took, and the HEAD it left behind when it committed.
 */
interface Outcome<S, N extends string> {
  readonly patched: S;
  readonly next: N;
  readonly elapsed: number;
  readonly head?: string;
}

/**
 * Steps 10 and 11's record: the patched state with its cursor moved on, `lastHead` carried over —
 * or replaced by the committed node's HEAD — and `timings[node]` grown by `elapsed`. Every other
 * `timings` entry is kept, and the record handed in is never mutated.
 */
function nextRecord<S extends GraphState<N>, N extends string>(id: N, outcome: Outcome<S, N>): S {
  const { patched, next, elapsed, head } = outcome;
  // `id` is a declared node id, so `timings[id]` may name a key the timing record never held —
  // and a node id that shadows a prototype key (`constructor`) would read the inherited value.
  const spent = Object.hasOwn(patched.timings, id) ? patched.timings[id] : 0;
  const timings: Record<string, number> = { ...patched.timings, [id]: spent + elapsed };
  return { ...patched, step: next, timings, ...(head === undefined ? {} : { lastHead: head }) } as S;
}

/**
 * Step 8: the patch applied key by key, so a key the patch states as `undefined` is *cleared*
 * rather than merged in. The same rule `runFeatureMachine`'s own `applyPatch` follows; the
 * engine copies it rather than importing it, because the workflow is G2's to port.
 *
 * A value is written as an **own data property**, never with `next[key] = value`: a declared key
 * such as `__proto__` has an inherited accessor on `Object.prototype`, so plain assignment would
 * set the record's prototype instead of storing the field. The patch's output would then vanish
 * from the persisted record (the next spread copies own properties only) while the record started
 * inheriting every field of the patched value, which its own guards would read as state.
 */
function applyPatch<S>(state: S, patch: Partial<S>): S {
  const next: Record<string, unknown> = { ...(state as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else Object.defineProperty(next, key, { value, writable: true, enumerable: true, configurable: true });
  }
  return next as unknown as S;
}

/**
 * Step 8: whether one transition takes this result. A transition with `on` never matches a
 * result with no exit, and `when` reads the post-patch state.
 */
function matches<S, E>(transition: StepTransition<S, E, string>, exit: string | undefined, state: S, env: E): boolean {
  if (transition.on !== undefined && transition.on !== exit) return false;
  return transition.when === undefined || transition.when(state, env);
}

/** Step 8: the first transition that passes both its `on` and its `when`. */
function nextNodeOf<S, E, N extends string>(
  id: N,
  node: StepNode<S, E, N>,
  result: StepResult<S>,
  patched: S,
  env: E,
): N {
  const taken = node.transitions.find((transition) => matches(transition, result.exit, patched, env));
  if (taken === undefined) {
    const extra = result.exit === undefined ? {} : { exit: result.exit };
    throw refusal(`node "${id}" has no transition matching its result`, "STEP_GRAPH_NO_TRANSITION", id, extra);
  }
  return taken.to;
}

/**
 * One `info` line on the engine's own stage, `storyId` first in its data (the logger convention).
 * `rest` continues the message straight after the node id, so the three lines differ only in their
 * tail; `durationMs`, when given, is in the data too.
 *
 * Nothing is written unless the caller asked for the engine's step lines (`logScope` set): a graph
 * whose steps write their own lines — the feature workflow and every other existing caller — gets
 * exactly the log it has today.
 */
function stepLine<N extends string>(options: StepGraphRunOptions<N>, id: N, rest: string, durationMs?: number): void {
  const scope = options.logScope;
  if (scope === undefined) return;
  const data = durationMs === undefined ? { storyId: scope, step: id } : { storyId: scope, step: id, durationMs };
  getSafeLogger()?.info("step-graph", `${id}${rest}`, data);
}

/**
 * Step 9: the HEAD a committing node left behind, fail-soft. A failed read must not lose the work
 * the node already did, so the record keeps the `lastHead` it had and one `warn` says so.
 *
 * This catch is a backstop: G2 injects the workflow's own `readHeadSoft`, which catches, logs the
 * workflow's existing warning and resolves `undefined`, so the G0 goldens keep that warning.
 */
async function readHeadAfter<N extends string>(
  commits: boolean,
  id: N,
  options: StepGraphRunOptions<N>,
): Promise<string | undefined> {
  if (!commits || options.readHead === undefined) return undefined;
  try {
    const head = await options.readHead();
    // `runFeatureMachine`'s rule: no readable HEAD means no new one, never an empty `lastHead`.
    return head === undefined || head === "" ? undefined : head;
  } catch (err) {
    getSafeLogger()?.warn(
      "step-graph",
      `Could not read HEAD after committing node ${id}; the record keeps the last one`,
      { storyId: options.logScope ?? "_run", node: id, error: errorMessage(err) },
    );
    return undefined;
  }
}

/**
 * Step 6: what the graph substitutes for an agent node's work once the cost limit is reached.
 * `undefined` — the answer for every node that is not an `agent`, and for an agent node past a
 * limit its graph does not stop — means run the node.
 */
async function costStopFor<S extends GraphState<N>, E, N extends string>(
  graph: StepGraph<S, E, N>,
  node: StepNode<S, E, N>,
  env: E,
  state: S,
  options: StepGraphRunOptions<N>,
): Promise<CostStop<S, N> | undefined> {
  if (node.kind !== "agent" || options.costExceeded?.() !== true) return undefined;
  const stop = await graph.costStop?.(state.step, state, env);
  if (stop === undefined) return undefined;
  assertCostStopDeclared(state.step, graph, stop.patch);
  assertDestination(graph, stop.to);
  return stop;
}

/**
 * Steps 6, 8 and 10 for a cost-stopped node: no `run`, no transition, no HEAD — its patch applied,
 * its `to` the cursor, and its elapsed time still recorded under its own id.
 */
function stoppedOutcome<S extends GraphState<N>, N extends string>(
  state: S,
  stop: CostStop<S, N>,
  elapsed: number,
  options: StepGraphRunOptions<N>,
): Outcome<S, N> {
  stepLine(options, state.step, `: skipped (cost limit reached)  ${formatDuration(elapsed)}`, elapsed);
  return { patched: applyPatch(state, stop.patch), next: stop.to, elapsed };
}

/** Steps 7, 8, 9 and 10 for a node that runs: its result, its transition and the HEAD it moved. */
async function executedOutcome<S extends GraphState<N>, E, N extends string>(
  node: StepNode<S, E, N>,
  env: E,
  state: S,
  options: StepGraphRunOptions<N>,
  started: number,
): Promise<Outcome<S, N>> {
  const id = state.step;
  stepLine(options, id, " start");
  const result: StepResult<S> = await node.run(env, state);
  assertPatchDeclared(id, node, result.patch);
  assertExitDeclared(id, node, result.exit);
  const patched = applyPatch(state, result.patch);
  const next = nextNodeOf(id, node, result, patched, env);
  const head = await readHeadAfter(node.commits === true, id, options);
  const elapsed = options.now() - started;
  stepLine(options, id, `: done  ${formatDuration(elapsed)}`, elapsed);
  return { patched, next, elapsed, head };
}

/** Steps 3-11 for one node: the body of a single loop iteration. */
async function stepOnce<S extends GraphState<N>, E, N extends string>(
  graph: StepGraph<S, E, N>,
  env: E,
  state: S,
  hooks: StepGraphHooks<S, N>,
  options: StepGraphRunOptions<N>,
): Promise<S> {
  const id = state.step;
  // Step 2 before step 3 on purpose: a bad cursor is reported ahead of an abort that would mask it.
  const node = nodeOf(graph, id);
  if (options.aborted()) throw abortRefusal(id, options.onAbort);
  hooks.onStep?.(id, state);
  const started = options.now();
  const stop = await costStopFor(graph, node, env, state, options);
  const outcome =
    stop === undefined
      ? await executedOutcome(node, env, state, options, started)
      : stoppedOutcome(state, stop, options.now() - started, options);
  const nextState = nextRecord(id, outcome);
  await hooks.persist(nextState);
  return nextState;
}

/**
 * Run `graph` from the cursor its record carries, one node at a time, persisting the record
 * after each. `state.step` is the truth: `graph.start` is metadata, not an instruction to
 * overwrite a recorded cursor, so a resumed run continues where it stopped.
 */
export async function runStepGraph<S extends GraphState<N>, E, N extends string>(
  graph: StepGraph<S, E, N>,
  env: E,
  state: S,
  hooks: StepGraphHooks<S, N>,
  options: StepGraphRunOptions<N>,
): Promise<S> {
  defineStepGraph(graph);
  let current = state;
  while (!graph.end.includes(current.step)) {
    current = await stepOnce(graph, env, current, hooks, options);
  }
  hooks.onStep?.(current.step, current);
  return current;
}
