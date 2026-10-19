/**
 * G0 (step-graph equivalence): record what the story loop does at its injection seams into the same
 * comparable trace the feature machine writes (US-001), so one format holds both machines. Test-only;
 * nothing here is imported by `src/`.
 *
 * The seams are `StoryLoopEnv.steps`, `StoryLoopEnv.advisor` and `StoryLoopEnv.sink`, plus the run log,
 * so a trace describes behaviour and not implementation: an engine that keeps the seams and the
 * interactions reproduces it byte for byte.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { WorkflowAdvisor } from "@/workflow/advisor";
import { runStoryLoop, type StoryLoopEnv, type StoryLoopSink, type StoryLoopSteps } from "@/workflow/story-loop";
import {
  snapshot,
  snapshotOptions,
  type TraceEnd,
  type TraceEvent,
  tracedAsync,
  tracedSync,
  type WorkflowTrace,
} from "./workflow-trace";

/** What `recordStoryTrace` needs from a scripted harness: the `StoryLoopEnv` the loop runs on. */
export interface StoryTraceHarness {
  readonly env: StoryLoopEnv;
}

/** The run-log stage whose lines a trace keeps; everything else is another module's voice. */
const WORKFLOW_STAGE = "workflow";

/**
 * The seam methods the harness actually provides, wrapped. `workProduced` and `modelFor` are optional
 * and the loop branches on whether they exist, so one the harness leaves out stays absent here.
 */
function wrapSteps(steps: StoryLoopSteps, events: TraceEvent[]): StoryLoopSteps {
  const workProduced = steps.workProduced;
  const modelFor = steps.modelFor;
  return {
    implement: tracedAsync("implement", steps.implement.bind(steps), events),
    gates: tracedAsync("gates", steps.gates.bind(steps), events),
    fullSuite: tracedAsync("fullSuite", steps.fullSuite.bind(steps), events),
    storyReview: tracedAsync("storyReview", steps.storyReview.bind(steps), events),
    reReview: tracedAsync("reReview", steps.reReview.bind(steps), events),
    head: tracedAsync("head", steps.head.bind(steps), events),
    uncommitted: tracedAsync("uncommitted", steps.uncommitted.bind(steps), events),
    costExceeded: tracedSync("costExceeded", steps.costExceeded.bind(steps), events),
    ...(workProduced ? { workProduced: tracedAsync("workProduced", workProduced.bind(steps), events) } : {}),
    ...(modelFor ? { modelFor: tracedSync("modelFor", modelFor.bind(steps), events) } : {}),
  };
}

/** The advisor's two answers, recorded before they run so their order is the loop's order. */
function wrapAdvisor(advisor: WorkflowAdvisor, events: TraceEvent[]): WorkflowAdvisor {
  return {
    answerQuestion: tracedAsync("answerQuestion", advisor.answerQuestion.bind(advisor), events),
    ruleResidual: tracedAsync("ruleResidual", advisor.ruleResidual.bind(advisor), events),
  };
}

/**
 * The sink's two writes. They are closures on purpose: `adjudicateResidual` is handed `env.sink.ledger`
 * unbound, so an object method that read `this` would throw there.
 */
function wrapSink(sink: StoryLoopSink, events: TraceEvent[]): StoryLoopSink {
  return {
    update: async (patch) => {
      events.push({ kind: "update", record: snapshot(patch) });
      await sink.update(patch);
    },
    ledger: async (text, options) => {
      events.push({ kind: "ledger", text, options: snapshotOptions(options) });
      await sink.ledger(text, options);
    },
  };
}

/** `{ threw: { code, message } }` for anything the loop let escape; never rethrown. */
function thrownBy(err: unknown): TraceEnd["threw"] {
  return { code: err instanceof NaxError ? err.code : null, message: errorMessage(err) };
}

/**
 * Runs `runStoryLoop` on the harness env with its seams and the run log recorded, and resolves with the
 * trace — including when the loop throws, which is recorded in `end`, not rethrown.
 */
export async function recordStoryTrace(scenario: string, harness: StoryTraceHarness): Promise<WorkflowTrace> {
  const events: TraceEvent[] = [];
  const env: StoryLoopEnv = {
    ...harness.env,
    steps: wrapSteps(harness.env.steps, events),
    advisor: wrapAdvisor(harness.env.advisor, events),
    sink: wrapSink(harness.env.sink, events),
  };
  resetLogger();
  initLogger({ level: "silent" });
  const unsubscribe = addSink((entry) => {
    if (entry.stage !== WORKFLOW_STAGE) return;
    const data = entry.data === undefined ? undefined : snapshot(entry.data);
    events.push({ kind: "log", level: entry.level, message: entry.message, data });
  });
  try {
    const returned = await runStoryLoop(env);
    // `end` keeps the loop's own value rather than a copy: it is the finished outcome, not one of the
    // interactions the trace pins (AC-8 pins its shape, not an identity).
    return { scenario, machine: "story", events, end: { returned } };
  } catch (err) {
    return { scenario, machine: "story", events, end: { threw: thrownBy(err) } };
  } finally {
    unsubscribe();
    resetLogger();
  }
}
