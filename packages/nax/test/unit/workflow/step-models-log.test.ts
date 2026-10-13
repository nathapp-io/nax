/** nax#2491 P6: each agent step's start line names the model it resolved to. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { defaultWorkflowAdvisor } from "@/workflow/advisor";
import { type FeatureEnv, type FeatureSteps, runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import { newStoryRecord } from "@/workflow/result";
import { startStep } from "@/workflow/run-log";
import { runStoryLoop, type StoryLoopEnv, type StoryLoopSteps } from "@/workflow/story-loop";
import type { BranchReviewVerdict, StorySummary } from "@/workflow/types";

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => resetLogger());

const startLines = () =>
  logs
    .filter((e) => e.stage === "workflow" && e.message.endsWith(" start"))
    .map((e) => ({ message: e.message, data: e.data ?? {} }));

describe("startStep", () => {
  test("a model adds agentName and model to the start line's data, the message is unchanged", () => {
    startStep("US-004", "fix r4", { model: { agentName: "native", model: "model-a" } });
    expect(startLines()).toEqual([
      { message: "US-004 fix r4 start", data: expect.objectContaining({ agentName: "native", model: "model-a" }) },
    ]);
  });

  test("no model, no model fields", () => {
    startStep("US-004", "implementer");
    expect(startLines()[0]?.data).not.toHaveProperty("model");
  });
});

const GREEN = { red: false, states: { lint: "green" as const }, findings: [] };
const DONE = {
  reply: { status: "DONE" as const, commits: [], testSummary: "", interrupted: false },
  autoCommitted: false,
};

function loopEnv(): StoryLoopEnv {
  let record = newStoryRecord("US-004", 5, "t");
  let reviews = 0;
  const steps: StoryLoopSteps = {
    implement: async () => DONE,
    gates: async () => GREEN,
    fullSuite: async () => GREEN,
    storyReview: async () => {
      reviews += 1;
      return {
        ran: true,
        verdict: {
          spec: "fail",
          quality: "changes",
          findings: reviews === 1 ? [{ kind: "spec", severity: "important", issue: "gap" }] : [],
          cannotVerify: [],
          inspectedFiles: [],
        },
      };
    },
    reReview: async () => ({
      ran: true,
      verdict: { verdicts: [{ id: "F1", addressed: true, note: "" }], newFindings: [] },
    }),
    head: async () => "h",
    uncommitted: async () => [],
    costExceeded: () => false,
    modelFor: (step, turn) => ({
      agentName: "native",
      model: step === "implementer" ? `impl-${turn?.kind === "fix" ? turn.stepUps : 0}` : `${step}-model`,
    }),
  };
  return {
    storyId: "US-004",
    maxFixRounds: 5,
    advisor: defaultWorkflowAdvisor,
    resume: null,
    sink: {
      update: async (patch) => {
        record = { ...record, ...patch };
      },
      ledger: async () => {},
    },
    steps,
  };
}

describe("story loop step models", () => {
  test("implementer, fix, story-review and re-review start lines carry their model", async () => {
    await runStoryLoop(loopEnv());
    const byMessage = new Map(startLines().map((l) => [l.message, l.data.model]));
    expect(byMessage.get("US-004 implementer start")).toBe("impl-0");
    expect(byMessage.get("US-004 story-review start")).toBe("story-review-model");
    expect(byMessage.get("US-004 fix r1 start")).toBe("impl-0");
    expect(byMessage.get("US-004 re-review r1 start")).toBe("re-review-model");
  });

  test("a loop whose steps name no models still logs its start lines", async () => {
    const env = loopEnv();
    const { modelFor: _drop, ...steps } = env.steps;
    await runStoryLoop({ ...env, steps });
    expect(startLines().map((l) => l.message)).toContain("US-004 implementer start");
    expect(startLines()[0]?.data).not.toHaveProperty("model");
  });
});

const REVIEW: BranchReviewVerdict = {
  spec: "fail",
  quality: "changes",
  findings: [{ kind: "quality", severity: "important", issue: "one" }],
  cannotVerify: [],
  inspectedFiles: [],
  minorTriage: [],
};
const story: StorySummary = { id: "US-001", title: "t", state: "complete", rounds: 0, unreviewed: false, flagged: 0 };

describe("feature machine step models", () => {
  test("branch-review, branch-fix and branch-rereview start lines carry their model", async () => {
    let clock = 0;
    const steps: FeatureSteps = {
      repoGates: async () => ({ summary: { ran: ["build"], failing: [] }, findings: [] }),
      branchReview: async () => ({ ran: true, verdict: REVIEW }),
      branchFix: async () => ({ autoCommitted: false, dirty: false }),
      branchReReview: async (findings) => ({
        ran: true,
        verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] },
      }),
      adjudicate: async () => [],
      publish: async () => ({ outcome: "local-only", ci: "skipped", reasons: [] }),
      head: async () => "h",
      changedFiles: async () => [],
      modelFor: (step) => ({ agentName: "native", model: `${step}-model` }),
    };
    const env: FeatureEnv = {
      steps,
      sink: { update: async () => {}, ledger: async () => {}, artifact: async () => {}, step: () => {} },
      facts: { stories: [story], parked: [], cannotVerify: [] },
      record: newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
      aborted: () => false,
      now: () => (clock += 1000),
    };
    await runFeatureMachine(env);
    const byMessage = new Map(startLines().map((l) => [l.message, l.data.model]));
    expect(byMessage.get("branch-review start")).toBe("branch-review-model");
    expect(byMessage.get("branch-fix start")).toBe("branch-fix-model");
    expect(byMessage.get("branch-rereview start")).toBe("branch-rereview-model");
  });
});
