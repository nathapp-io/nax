/**
 * The generic step graph contracts (G1).
 *
 * A graph is data: named nodes, each with a kind, the record keys it needs and produces,
 * whether it can commit, a run function and an ordered list of transitions. `runStepGraph`
 * (US-002) is the only runner; nothing in nax consumes the engine yet — G2 ports the
 * feature workflow onto it.
 *
 * This module imports nothing from `src/workflow/`: G2 makes the workflow import the engine,
 * and the reverse edge would close an import cycle that `check:import-cycles` counts.
 *
 * Spec: docs/specs/SPEC-step-graph-g1-engine.md § Types.
 */

/** What a node does, so the runner can treat `agent` nodes differently (the cost stop, US-003). */
export type StepKind = "agent" | "gate" | "git" | "forge" | "pure";

/** The engine-owned fields every graph record carries. */
export interface GraphState<N extends string> {
  /** The cursor: the next node to run, or an end id. */
  readonly step: N;
  /** Milliseconds spent per node id, accumulated across every visit. */
  readonly timings: Readonly<Record<string, number>>;
  /** HEAD after the last committing node. */
  readonly lastHead?: string;
}

/** The record keys the engine writes itself; no node may declare or patch them. */
export const ENGINE_KEYS = ["step", "timings", "lastHead"] as const;

export interface StepResult<S> {
  /** Applied key by key; a key whose value is `undefined` is deleted. */
  readonly patch: Partial<S>;
  /** An optional label the transitions can match; never persisted. */
  readonly exit?: string;
}

export interface StepTransition<S, E, N extends string> {
  readonly to: N;
  /** Matches `StepResult.exit`. A transition with `on` never matches a result with no exit. */
  readonly on?: string;
  /** Evaluated on the post-patch state, with the run's environment. */
  readonly when?: (state: S, env: E) => boolean;
}

export interface StepNode<S, E, N extends string> {
  readonly kind: StepKind;
  /** The node can commit, so the runner records `lastHead` after it (US-003). */
  readonly commits?: boolean;
  /** The record keys this node's `run` reads. */
  readonly needs?: readonly string[];
  /** The record keys this node's `run` may patch. Never an engine key. */
  readonly produces: readonly string[];
  /** The labels this node's `run` may return as `StepResult.exit`. */
  readonly exits?: readonly string[];
  /** Ordered: the first transition that matches decides the next node. */
  readonly transitions: readonly StepTransition<S, E, N>[];
  run(env: E, state: S): Promise<StepResult<S>>;
}

/** What a graph's `costStop` hook returns for an `agent` node past the cost limit. */
export interface CostStop<S, N extends string> {
  readonly patch: Partial<S>;
  readonly to: N;
}

export interface StepGraph<S extends GraphState<N>, E, N extends string> {
  /** The first node to run. */
  readonly start: N;
  /** The ids that end the run. */
  readonly end: readonly N[];
  /** The keys the initial record supplies. */
  readonly inputs?: readonly string[];
  readonly nodes: Readonly<Partial<Record<N, StepNode<S, E, N>>>>;
  /** The keys a `costStop` patch may set; required when `costStop` is defined. */
  readonly costStopProduces?: readonly string[];
  /** Asked only for an agent node while the cost limit is exceeded; `undefined` = run the node. */
  costStop?(node: N, state: S, env: E): Promise<CostStop<S, N> | undefined>;
}

export interface StepGraphHooks<S, N extends string> {
  /** Called after every node with the record the runner now holds. */
  persist(state: S): Promise<void>;
  /** Called with the node about to run, and once with the end id after the loop. */
  onStep?(node: N, state: S): void;
}

export interface StepGraphRunOptions<N extends string> {
  aborted(): boolean;
  /** The run's clock, in milliseconds. Read exactly twice per node. */
  now(): number;
  costExceeded?(): boolean;
  readHead?(): Promise<string | undefined>;
  onAbort?(node: N): Error;
  /** Set = the engine logs its own step lines. */
  logScope?: string;
}

/**
 * What `validateStepGraph` reads: the declarations only, with the ids widened to `string`
 * and the run functions and guards dropped, so validation can never invoke a node. Every
 * `StepGraph` is assignable to it, and so is a graph assembled at runtime that TypeScript
 * could not check.
 */
export interface StepGraphDeclaration {
  readonly start: string;
  readonly end: readonly string[];
  readonly inputs?: readonly string[];
  readonly nodes: Readonly<Record<string, StepNodeDeclaration | undefined>>;
  readonly costStopProduces?: readonly string[];
  readonly costStop?: unknown;
}

export type StepNodeDeclaration = Pick<
  StepNode<never, never, string>,
  "kind" | "commits" | "needs" | "produces" | "exits"
> & {
  readonly transitions: readonly StepTransitionDeclaration[];
};

export type StepTransitionDeclaration = Pick<StepTransition<never, never, string>, "to" | "on">;
