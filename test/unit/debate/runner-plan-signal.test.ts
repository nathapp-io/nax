import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeMockAgentManager, makeMockRuntime, makeSessionManager, makeNaxConfig } from "@test/helpers";
import * as callModule from "@/operations";
import { _debateSessionDeps } from "@/debate";
import { runPlan } from "../../../src/debate/runner-plan";

interface PlanCallInput {
  readonly debater?: { readonly agent: string; readonly model?: string };
  readonly selectionSignal?: Promise<{ readonly patchPrompt?: string }>;
  readonly rebuttalBarrier?: { readonly resolve: (value: string) => void };
}

function makePlanContext() {
  const config = makeNaxConfig({
    debate: {
      maxConcurrentDebaters: 2,
    },
    agent: {
      default: "claude",
    },
  });
  const agentManager = makeMockAgentManager();
  const sessionManager = makeSessionManager({
    runInSession: mock(async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCostUsd: 0,
    })),
  });
  const runtime = makeMockRuntime({ agentManager, sessionManager, config });

  return {
    runtime,
    agentManager,
    sessionManager,
    storyId: "US-PLAN",
    stage: "plan",
    stageConfig: {
      enabled: true,
      resolver: { type: "majority-fail-closed" as const },
      sessionMode: "one-shot" as const,
      mode: "panel" as const,
      rounds: 1,
      selector: {
        kind: "verifier-pick" as const,
        patch: { enabled: true, overlapThreshold: 0.5, maxDeltas: 3 },
      },
      debaters: [
        { agent: "claude", model: "fast" },
        { agent: "opencode", model: "balanced" },
      ],
    },
    config,
    callContext: {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: runtime.workdir,
      agentName: "claude",
      storyId: "US-PLAN",
      featureName: "feat-plan",
    },
    abortSignal: runtime.signal,
  } as Parameters<typeof runPlan>[0];
}

beforeEach(() => {
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }));
  _debateSessionDeps.readFile = mock(async () => "{\"passed\":true}");
});

afterEach(() => {
  mock.restore();
});

describe("runPlan coordinator", () => {
  test("launches plan debaters through callOp with selection signals and rebuttal barriers instead of session-manager turns", async () => {
    const ctx = makePlanContext();
    const callInputs: PlanCallInput[] = [];
    const callOpSpy = spyOn(callModule, "callOp").mockImplementation(async (_callCtx, op, input) => {
      callInputs.push({
        debater: (input as PlanCallInput).debater,
        selectionSignal: (input as PlanCallInput).selectionSignal,
        rebuttalBarrier: (input as PlanCallInput).rebuttalBarrier,
      });
      return { success: true, rebut: "rebut-0" } as never;
    });

    await runPlan(ctx, "task context", "output format", {
      workdir: "/tmp/work",
      feature: "feat-plan",
      outputDir: "/tmp/out",
    });

    expect(callOpSpy).toHaveBeenCalledTimes(2);
    expect(callInputs).toHaveLength(2);
    expect(callInputs.every((input) => input.selectionSignal !== undefined)).toBe(true);
    expect(callInputs.every((input) => input.rebuttalBarrier !== undefined)).toBe(true);
    expect(ctx.sessionManager.runInSession).not.toHaveBeenCalled();
  });

  test("runner-plan.ts and runner-plan-helpers.ts do not contain the legacy session-manager and inline prompt strings", async () => {
    const [runnerSource, helpersSource] = await Promise.all([
      Bun.file("src/debate/runner-plan.ts").text(),
      Bun.file("src/debate/runner-plan-helpers.ts").text(),
    ]);

    const forbiddenSnippets = [
      "sessionManager.openSession",
      "sessionManager.closeSession",
      "agentManager.runAsSession",
      "resolveModelDefForDebater",
      "ctx.config.models",
      "openPlanSessions",
      "closePlanSessions",
      "runStatefulPlanTurn",
      "makeStatefulProposal",
      "Write the PRD JSON directly to this file path:",
    ];

    for (const snippet of forbiddenSnippets) {
      expect(runnerSource).not.toContain(snippet);
      expect(helpersSource).not.toContain(snippet);
    }
  });
});
