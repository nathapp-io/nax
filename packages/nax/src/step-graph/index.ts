/**
 * `src/step-graph` — the generic step graph engine (G1).
 *
 * A graph is data and one runner owns the loop: it persists the record after every node,
 * resumes at the node the record names, and calls only what the caller injects. Nothing in
 * nax consumes it yet; G2 ports the feature workflow onto it.
 *
 * Usage: `defineStepGraph` once at the definition site, `validateStepGraph` for a graph
 * assembled at runtime, and `runStepGraph` (US-002) to run one.
 *
 * Spec: docs/specs/SPEC-step-graph-g1-engine.md.
 */

export { runStepGraph } from "./run";
export {
  type CostStop,
  ENGINE_KEYS,
  type GraphState,
  type StepGraph,
  type StepGraphDeclaration,
  type StepGraphHooks,
  type StepGraphRunOptions,
  type StepKind,
  type StepNode,
  type StepNodeDeclaration,
  type StepResult,
  type StepTransition,
  type StepTransitionDeclaration,
} from "./types";
export { defineStepGraph, validateStepGraph } from "./validate";
