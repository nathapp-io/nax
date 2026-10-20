/**
 * The story state machine (spec §6). Pure orchestration over injected steps:
 * no I/O of its own, so every branch is unit-testable. W-R3: it always returns
 * an end state; it never fails or pauses a story.
 *
 * G3: the machine is `STORY_GRAPH` (story-graph.ts), run by the step graph engine. This module
 * keeps the env contract, the state type the engine threads, and the one engine call; the nodes
 * and their helpers live in `story-steps.ts`.
 *
 * Spec: docs/specs/SPEC-step-graph-g3-story-port.md § State and § Wiring.
 */
import { NaxError } from "@/errors";
import { type GraphState, runStepGraph, type StepGraphHooks, type StepGraphRunOptions } from "@/step-graph";
import type { WorkflowAdvisor } from "./advisor";
import type { ImplementOutcome, ImplementTurn } from "./implement";
import type { LedgerWriteOptions } from "./ledger";
import type { StepModel } from "./run-log";
import { STORY_GRAPH } from "./story-graph";
import type { ReviewOutcome } from "./story-review";
import { initialStoryState } from "./story-steps";
import type {
  GateName,
  GateRunResult,
  GateState,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowEndState,
  WorkflowFinding,
  WorkflowRuling,
  WorkflowStoryRecord,
} from "./types";

export { turnLabel } from "./story-steps";

export interface StoryLoopSteps {
  implement(turn: ImplementTurn): Promise<ImplementOutcome>;
  gates(): Promise<GateRunResult>;
  fullSuite(): Promise<GateRunResult>;
  /**
   * US-006 (nax#2527): `gates` is the states the loop already recorded, so the reviewer prompt
   * states what nax checked. Optional so a caller that never ran the gates still compiles.
   */
  storyReview(
    concerns: readonly string[],
    gates?: Readonly<Partial<Record<GateName, GateState>>>,
  ): Promise<ReviewOutcome<StoryReviewVerdict>>;
  reReview(
    round: number,
    findings: readonly WorkflowFinding[],
    fixBase: string,
  ): Promise<ReviewOutcome<ReReviewVerdict>>;
  head(): Promise<string>;
  uncommitted(): Promise<string[]>;
  costExceeded(): boolean;
  /**
   * US-002: did the story leave any work evidence behind? Absent means "work produced", so the
   * no-work guard never fires for a caller that has not wired it.
   */
  workProduced?(): Promise<boolean>;
  /** The model a step will run on, for its start line (nax#2491 P6). Optional: absent names none. */
  modelFor?(step: "implementer" | "story-review" | "re-review", turn?: ImplementTurn): StepModel | undefined;
}
export interface StoryLoopSink {
  update(patch: Partial<WorkflowStoryRecord>): Promise<void>;
  ledger(text: string, options?: LedgerWriteOptions): Promise<void>;
}
export interface StoryLoopEnv {
  readonly storyId: string;
  readonly maxFixRounds: number;
  readonly steps: StoryLoopSteps;
  readonly advisor: WorkflowAdvisor;
  readonly sink: StoryLoopSink;
  /** A prior run's unfinished record (spec §10 resume); null for a fresh story. */
  readonly resume: WorkflowStoryRecord | null;
}
export interface StoryLoopOutcome {
  readonly state: WorkflowEndState;
  readonly reason: string;
  readonly rounds: number;
  readonly rulings: readonly WorkflowRuling[];
  readonly unreviewed: boolean;
}

/** The graph's node ids and end id; `done` is reached only from `close`. */
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
