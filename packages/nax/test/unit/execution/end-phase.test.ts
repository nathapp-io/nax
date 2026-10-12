import { afterEach, describe, expect, test } from "bun:test";
import { makeDispatchContext, makeNaxConfig, makePRD, makeStatusWriter } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { _endPhaseDeps, type EndPhaseDeps, finishStorySummary, runEndPhase } from "@/execution/end-phase";
import type { RunnerCompletionOptions } from "@/execution/runner-completion";
import type { FinishPhaseContext } from "@/finish";
import type { LoadedHooksConfig } from "@/hooks";
import { PluginRegistry } from "@/plugins";
import type { WorkflowFeatureInput, WorkflowFeatureResult } from "@/workflow";

const original = { ..._endPhaseDeps };
afterEach(() => Object.assign(_endPhaseDeps, original));

function opts(config: NaxConfig, over: Partial<RunnerCompletionOptions> = {}): RunnerCompletionOptions {
  return {
    config,
    hooks: { hooks: {}, _skipGlobal: false } satisfies LoadedHooksConfig,
    feature: "f",
    workdir: "/repo",
    statusFile: "/repo/status.json",
    runId: "run-1",
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    formatterMode: "quiet",
    headless: false,
    prd: makePRD({ feature: "f" }),
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter: makeStatusWriter(),
    pluginRegistry: new PluginRegistry([]),
    prdPath: "/repo/prd.json",
    ...makeDispatchContext(),
    ...over,
  };
}

function deps(result: WorkflowFeatureResult | null | Error = null) {
  const finish: FinishPhaseContext[] = [];
  const workflow: WorkflowFeatureInput[] = [];
  const d: EndPhaseDeps = {
    runFinishPhase: async (ctx) => {
      finish.push(ctx);
      return null;
    },
    runWorkflowFeature: async (input) => {
      workflow.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { d, finish, workflow };
}

const PIPELINE = makeNaxConfig({});
const WORKFLOW = makeNaxConfig({ execution: { mode: "workflow" } });

describe("runEndPhase (P4-R16)", () => {
  test("pipeline mode: finish runs with the same context as before; workflowPassed undefined", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const { d, finish, workflow } = deps();
    expect(await runEndPhase(opts(PIPELINE), d)).toBeUndefined();
    expect(workflow).toHaveLength(0);
    expect(finish[0]).toMatchObject({ feature: "f", workdir: "/repo", branch: "feat/x", runId: "run-1" });
    expect(finish[0]?.storySummary).toEqual(finishStorySummary(opts(PIPELINE)));
  });

  test("pipeline mode: a finish throw is swallowed (fail-open)", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const d: EndPhaseDeps = {
      runFinishPhase: async () => {
        throw new Error("finish broke");
      },
      runWorkflowFeature: async () => null,
    };
    expect(await runEndPhase(opts(PIPELINE), d)).toBeUndefined();
  });

  test("workflow mode: runWorkflowFeature instead of finish; passed flows out", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const { d, finish, workflow } = deps({ passed: false, outcome: "draft", reasons: ["CI failed"] });
    expect(await runEndPhase(opts(WORKFLOW), d)).toBe(false);
    expect(finish).toHaveLength(0);
    expect(workflow[0]).toMatchObject({ feature: "f", workdir: "/repo", branch: "feat/x", runId: "run-1" });
  });

  test("workflow mode: skipped (null) -> true; a throw -> false (P4-R13)", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    expect(await runEndPhase(opts(WORKFLOW), deps(null).d)).toBe(true);
    expect(await runEndPhase(opts(WORKFLOW), deps(new Error("boom")).d)).toBe(false);
  });

  test("workflow mode: an aborted run never starts the feature workflow", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const { d, workflow } = deps({ passed: true, outcome: "ready", reasons: [] });
    await runEndPhase(opts(WORKFLOW, { exitReason: "aborted" }), d);
    expect(workflow).toHaveLength(0);
  });
});
