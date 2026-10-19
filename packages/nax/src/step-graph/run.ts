/**
 * `src/step-graph/run.ts` — `runStepGraph`, the deterministic resumable runner.
 *
 * The runner owns the loop and nothing else: it calls only what the caller injects (the
 * nodes' `run` functions, the guards, the hooks and the run options), so a run is
 * reproducible from the record it was handed. It imports nothing from `src/workflow/` —
 * G2 makes the workflow import the engine, and the reverse edge would close an import
 * cycle that `check:import-cycles` counts.
 *
 * Spec: docs/specs/SPEC-step-graph-g1-engine.md § Runner order (steps 1-5, 7, 8, 10, 11).
 */
import { NaxError } from "@/errors";
import type {
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
 * Step 2: the node `id` names, or `STEP_GRAPH_UNKNOWN_NODE` when the graph has none.
 *
 * `id` is a persisted cursor, so it is runtime data: an inherited key (`constructor`,
 * `__proto__`, `toString`) would otherwise be read as a node the graph declares and then fail
 * with a `TypeError` on `node.run`. Only an *own* key of `graph.nodes` is a node id.
 */
function nodeOf<S extends GraphState<N>, E, N extends string>(graph: StepGraph<S, E, N>, id: N): StepNode<S, E, N> {
  const node = graph.nodes[id];
  if (node === undefined || !Object.hasOwn(graph.nodes, id)) {
    throw refusal(`step graph has no node "${id}"`, "STEP_GRAPH_UNKNOWN_NODE", id);
  }
  return node;
}

/** Step 3: the run's abort — the caller's own error when it supplies one. */
function abortRefusal<N extends string>(id: N, onAbort: StepGraphRunOptions<N>["onAbort"]): Error {
  return onAbort?.(id) ?? refusal(`the run was aborted before node "${id}"`, "STEP_GRAPH_ABORTED", id);
}

/** Step 7: every key a patch names is the node's to produce — a key stated as `undefined` too. */
function assertPatchDeclared<S, E, N extends string>(id: N, node: StepNode<S, E, N>, patch: Partial<S>): void {
  const produced = new Set<string>(node.produces);
  const undeclared = Object.keys(patch).find((key) => !produced.has(key));
  if (undeclared === undefined) return;
  throw refusal(
    `node "${id}" patched "${undeclared}", which its produces does not declare`,
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
 * Steps 10 and 11's record: the patched state with its cursor moved on, `lastHead` carried
 * over, and `timings[node]` grown by `elapsed`. Every other `timings` entry is kept, and the
 * record handed in is never mutated.
 */
function nextRecord<S extends GraphState<N>, N extends string>(patched: S, next: N, id: N, elapsed: number): S {
  // `id` is a declared node id, so `timings[id]` may name a key the timing record never held —
  // and a node id that shadows a prototype key (`constructor`) would read the inherited value.
  const spent = Object.hasOwn(patched.timings, id) ? patched.timings[id] : 0;
  const timings: Record<string, number> = { ...patched.timings, [id]: spent + elapsed };
  return { ...patched, step: next, timings } as S;
}

/**
 * Step 8: the patch applied key by key, so a key the patch states as `undefined` is *cleared*
 * rather than merged in. The same rule `runFeatureMachine`'s own `applyPatch` follows; the
 * engine copies it rather than importing it, because the workflow is G2's to port.
 */
function applyPatch<S>(state: S, patch: Partial<S>): S {
  const next: Record<string, unknown> = { ...(state as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
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

/** Steps 3-5, 7, 8, 10 and 11 for one node: the body of a single loop iteration. */
async function stepOnce<S extends GraphState<N>, E, N extends string>(
  env: E,
  state: S,
  node: StepNode<S, E, N>,
  hooks: StepGraphHooks<S, N>,
  options: StepGraphRunOptions<N>,
): Promise<S> {
  const id = state.step;
  if (options.aborted()) throw abortRefusal(id, options.onAbort);
  hooks.onStep?.(id, state);
  const started = options.now();
  const result: StepResult<S> = await node.run(env, state);
  assertPatchDeclared(id, node, result.patch);
  assertExitDeclared(id, node, result.exit);
  const patched = applyPatch(state, result.patch);
  const next = nextNodeOf(id, node, result, patched, env);
  const nextState = nextRecord(patched, next, id, options.now() - started);
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
    current = await stepOnce(env, current, nodeOf(graph, current.step), hooks, options);
  }
  hooks.onStep?.(current.step, current);
  return current;
}
