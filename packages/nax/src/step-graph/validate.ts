/**
 * `src/step-graph/validate.ts` — the aggregate graph validator.
 *
 * Validation reads declarations only: it never invokes a `run` function, a guard or the
 * `costStop` hook. `validateStepGraph` lists *every* violation so one run of it reports the
 * whole shape of a broken graph, not just its first problem; `defineStepGraph` turns that
 * list into one `NaxError` listing all of it.
 *
 * Spec: docs/specs/SPEC-step-graph-g1-engine.md § Validation rules.
 */
import { NaxError } from "@/errors";
import { ENGINE_KEYS, type StepGraphDeclaration, type StepNodeDeclaration } from "./types";

/** One declared node, with its id. */
type NodeEntry = readonly [id: string, node: StepNodeDeclaration];

/** `ENGINE_KEYS` as a set, so the per-node checks do not rebuild it. */
const ENGINE_KEY_SET: ReadonlySet<string> = new Set(ENGINE_KEYS);

/** A `[id, node]` view of `graph.nodes`, skipping the ids the graph leaves out. */
function nodeEntries(graph: StepGraphDeclaration): NodeEntry[] {
  return Object.entries(graph.nodes)
    .filter((entry): entry is [string, StepNodeDeclaration] => entry[1] !== undefined)
    .map(([id, node]) => [id, node]);
}

/** Run one per-node check over every declared node, in declaration order. */
function collect(entries: readonly NodeEntry[], check: (id: string, node: StepNodeDeclaration) => string[]): string[] {
  return entries.flatMap(([id, node]) => check(id, node));
}

/** Rule 1: `start` is a node id or an end id. */
function checkStart(graph: StepGraphDeclaration, known: ReadonlySet<string>): string[] {
  return known.has(graph.start) ? [] : [`start "${graph.start}" is neither a node id nor an end id`];
}

/** Rule 2: every transition `to` is a node id or an end id. */
function checkTransitionIds(id: string, node: StepNodeDeclaration, known: ReadonlySet<string>): string[] {
  return node.transitions
    .filter((transition) => !known.has(transition.to))
    .map((transition) => `node "${id}": transition to "${transition.to}" is neither a node id nor an end id`);
}

/** Rule 3: every node has at least one transition. */
function checkHasTransitions(id: string, node: StepNodeDeclaration): string[] {
  return node.transitions.length > 0 ? [] : [`node "${id}": has no transitions`];
}

/** Rule 4: no end id is also a node id. */
function checkEndIsNotNode(graph: StepGraphDeclaration, nodeIds: ReadonlySet<string>): string[] {
  return graph.end.filter((id) => nodeIds.has(id)).map((id) => `end id "${id}" is also a node id`);
}

/** Rule 5: a transition's `on` is one of its node's `exits`. */
function checkExits(id: string, node: StepNodeDeclaration): string[] {
  const exits = new Set(node.exits ?? []);
  return node.transitions
    .filter((transition) => transition.on !== undefined && !exits.has(transition.on))
    .map((transition) => `node "${id}": transition "on" "${transition.on}" is not one of its exits`);
}

/** Every key a node's `needs` may name: the engine's own, an input, a producer, a cost-stop output. */
function availableKeys(graph: StepGraphDeclaration, entries: readonly NodeEntry[]): ReadonlySet<string> {
  const keys = new Set<string>(ENGINE_KEYS);
  for (const key of graph.inputs ?? []) keys.add(key);
  for (const [, node] of entries) for (const key of node.produces) keys.add(key);
  for (const key of graph.costStopProduces ?? []) keys.add(key);
  return keys;
}

/** Rule 6: every key in a node's `needs` is supplied by the graph. */
function checkNeeds(id: string, node: StepNodeDeclaration, available: ReadonlySet<string>): string[] {
  return (node.needs ?? [])
    .filter((key) => !available.has(key))
    .map(
      (key) => `node "${id}": needs key "${key}", which no input, no node's produces and no costStopProduces declares`,
    );
}

/** Rule 7: no node's `produces` contains an engine key. */
function checkEngineKeyProduces(id: string, node: StepNodeDeclaration): string[] {
  return node.produces
    .filter((key) => ENGINE_KEY_SET.has(key))
    .map((key) => `node "${id}": produces engine key "${key}"`);
}

/** Rule 7: `costStopProduces` contains no engine key either. */
function checkCostStopProduces(graph: StepGraphDeclaration): string[] {
  return (graph.costStopProduces ?? [])
    .filter((key) => ENGINE_KEY_SET.has(key))
    .map((key) => `costStopProduces: engine key "${key}" is engine-owned`);
}

/** Rule 8: an `agent` node needs a cost stop, and a cost stop needs its declared outputs. */
function checkCostStopDeclared(graph: StepGraphDeclaration, entries: readonly NodeEntry[]): string[] {
  if (graph.costStop === undefined) {
    return entries
      .filter(([, node]) => node.kind === "agent")
      .map(([id]) => `node "${id}": an "agent" node requires the graph to define costStop`);
  }
  return graph.costStopProduces === undefined ? ["costStop is defined but costStopProduces is not"] : [];
}

/**
 * Every violation of the graph's declarations, in rule order, each naming the node, key or
 * id it is about. An empty list means the graph is consistent.
 */
export function validateStepGraph(graph: StepGraphDeclaration): { errors: string[] } {
  const entries = nodeEntries(graph);
  const known = new Set([...entries.map(([id]) => id), ...graph.end]);
  const available = availableKeys(graph, entries);
  const errors = [
    ...checkStart(graph, known),
    ...collect(entries, (id, node) => checkTransitionIds(id, node, known)),
    ...collect(entries, checkHasTransitions),
    ...checkEndIsNotNode(graph, new Set(entries.map(([id]) => id))),
    ...collect(entries, checkExits),
    ...collect(entries, (id, node) => checkNeeds(id, node, available)),
    ...collect(entries, checkEngineKeyProduces),
    ...checkCostStopProduces(graph),
    ...checkCostStopDeclared(graph, entries),
  ];
  return { errors };
}

/**
 * `graph` unchanged when it validates, otherwise a `STEP_GRAPH_INVALID` `NaxError` listing
 * every violation. `runStepGraph` (US-002) calls this before it calls anything else, so a
 * graph that cannot run throws the same error through the same path.
 */
export function defineStepGraph<G extends StepGraphDeclaration>(graph: G): G {
  const { errors } = validateStepGraph(graph);
  if (errors.length === 0) return graph;
  throw new NaxError(`step graph is invalid:\n  - ${errors.join("\n  - ")}`, "STEP_GRAPH_INVALID", {
    stage: "step-graph",
    errors,
  });
}
