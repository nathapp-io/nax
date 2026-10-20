/**
 * `src/workflow/story-graph.ts` — the story workflow (spec §6) as one step graph value.
 *
 * The loop's five phases are the nodes and its three decision points are transitions, so the
 * `for (;;)` loop's `break`s are the graph's edges. The story loop's cost rule lives here rather
 * than in the engine: it asks `env.steps.costExceeded()` only at the top of an evaluate pass and
 * before a fix round, never before the first implement turn or the residual adjudication.
 *
 * Spec: docs/specs/SPEC-step-graph-g3-story-port.md § Node table, § Transitions, § Cost stop.
 */
import { type CostStop, defineStepGraph, type StepGraph } from "@/step-graph";
import type { StoryLoopEnv, StoryLoopState, StoryNode } from "./story-loop";
import { closeStep, evaluateStep, fixStep, implementStep, residualStep } from "./story-steps";

/** The two nodes the loop checked the cost limit before; every other agent node asks nothing. */
const COST_CHECKED: readonly StoryNode[] = ["evaluate", "fix"];

export const STORY_GRAPH: StepGraph<StoryLoopState, StoryLoopEnv, StoryNode> = defineStepGraph({
  start: "implement",
  end: ["done"],
  costStopProduces: ["costLimited"],
  nodes: {
    implement: {
      kind: "agent",
      produces: ["pendingSession", "nextId", "questions", "concerns", "closeAs"],
      exits: ["worked", "no-work"],
      transitions: [
        { on: "worked", to: "evaluate" },
        { on: "no-work", to: "close" },
      ],
      run: implementStep,
    },
    evaluate: {
      kind: "agent",
      produces: [
        "suiteThisIteration",
        "gates",
        "suite",
        "nextId",
        "reviewed",
        "unreviewed",
        "deferredMinors",
        "reviewOpen",
        "fixBase",
        "open",
        "pendingSession",
      ],
      exits: ["clean", "capped", "open"],
      transitions: [
        { on: "clean", to: "close" },
        { on: "capped", to: "residual" },
        { on: "open", to: "fix" },
      ],
      run: evaluateStep,
    },
    residual: {
      kind: "agent",
      produces: ["suite", "rulings"],
      transitions: [{ to: "close" }],
      run: residualStep,
    },
    fix: {
      kind: "agent",
      produces: ["round", "firstAfterResume", "fixBase", "pendingSession", "nextId", "questions", "concerns"],
      transitions: [{ to: "evaluate" }],
      run: fixStep,
    },
    close: {
      kind: "pure",
      produces: ["outcome"],
      transitions: [{ to: "done" }],
      run: closeStep,
    },
  },
  costStop: async (node, _state, env): Promise<CostStop<StoryLoopState, StoryNode> | undefined> => {
    if (!COST_CHECKED.includes(node) || !env.steps.costExceeded()) return undefined;
    return { patch: { costLimited: true }, to: "close" };
  },
});
