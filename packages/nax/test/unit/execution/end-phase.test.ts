import { afterEach, describe, expect, test } from "bun:test";
import { makeDispatchContext, makeNaxConfig, makePRD, makeStatusWriter, withInfoSpy, withWarnSpy } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
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

const PIPELINE = makeNaxConfig({ execution: { mode: "pipeline" } });
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
    expect((await runEndPhase(opts(WORKFLOW), d))?.passed).toBe(false);
    expect(finish).toHaveLength(0);
    expect(workflow[0]).toMatchObject({ feature: "f", workdir: "/repo", branch: "feat/x", runId: "run-1" });
  });

  test("workflow mode: skipped (null) -> true; a throw -> false (P4-R13)", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    expect((await runEndPhase(opts(WORKFLOW), deps(null).d))?.passed).toBe(true);
    expect((await runEndPhase(opts(WORKFLOW), deps(new Error("boom")).d))?.passed).toBe(false);
  });

  test("workflow mode: a WORKFLOW_ABORTED throw logs a distinct info message and returns false", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const aborted = new NaxError("Run aborted during the feature workflow", "WORKFLOW_ABORTED", { stage: "workflow" });
    await withInfoSpy(async (info) => {
      expect((await runEndPhase(opts(WORKFLOW), deps(aborted).d))?.passed).toBe(false);
      expect(info.mock.calls.some((c) => String(c[1]).includes("Feature workflow aborted"))).toBe(true);
    });
    await withWarnSpy(async (warn) => {
      expect((await runEndPhase(opts(WORKFLOW), deps(aborted).d))?.passed).toBe(false);
      expect(warn.mock.calls).toHaveLength(0);
    });
  });

  test("workflow mode: an ordinary throw still warns 'Feature workflow failed'", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    await withWarnSpy(async (warn) => {
      expect((await runEndPhase(opts(WORKFLOW), deps(new Error("boom")).d))?.passed).toBe(false);
      expect(warn.mock.calls.some((c) => String(c[1]).includes("Feature workflow failed"))).toBe(true);
    });
  });

  test("workflow mode: an aborted run never starts the feature workflow", async () => {
    _endPhaseDeps.resolveBranch = async () => "feat/x";
    const { d, workflow } = deps({ passed: true, outcome: "ready", reasons: [] });
    // nax#2550: the workflow did not run, so the run is not reported as a workflow success.
    expect((await runEndPhase(opts(WORKFLOW, { exitReason: "aborted" }), d))?.passed).toBe(false);
    expect(workflow).toHaveLength(0);
  });

  describe("runEndPhase end-phase outcome (US-001)", () => {
    test("AC-8: a passed workflow carries its url and reasons through", async () => {
      _endPhaseDeps.resolveBranch = async () => "feat/x";
      const { d } = deps({
        passed: true,
        outcome: "ready",
        url: "https://github.com/o/r/pull/295",
        reasons: [],
      });
      expect(await runEndPhase(opts(WORKFLOW), d)).toEqual({
        passed: true,
        url: "https://github.com/o/r/pull/295",
        reasons: [],
      });
    });

    test("AC-9: a skipped workflow (null) passes with no reasons and no url", async () => {
      _endPhaseDeps.resolveBranch = async () => "feat/x";
      const outcome = await runEndPhase(opts(WORKFLOW), deps(null).d);
      expect(outcome).toEqual({ passed: true, reasons: [] });
      expect(Object.hasOwn(outcome ?? {}, "url")).toBe(false);
    });

    test("AC-10: a thrown workflow fails with the message in its reasons", async () => {
      _endPhaseDeps.resolveBranch = async () => "feat/x";
      expect(await runEndPhase(opts(WORKFLOW), deps(new Error("boom")).d)).toEqual({
        passed: false,
        reasons: ["feature workflow failed: boom"],
      });
    });

    test("AC-11: a WORKFLOW_ABORTED throw is reported as an aborted run", async () => {
      _endPhaseDeps.resolveBranch = async () => "feat/x";
      const aborted = new NaxError("Run aborted during the feature workflow", "WORKFLOW_ABORTED", {
        stage: "workflow",
      });
      expect(await runEndPhase(opts(WORKFLOW), deps(aborted).d)).toEqual({ passed: false, reasons: ["run aborted"] });
    });

    test("AC-12: an already-aborted run is reported as an aborted run without starting the workflow", async () => {
      _endPhaseDeps.resolveBranch = async () => "feat/x";
      const { d, workflow } = deps({ passed: true, outcome: "ready", reasons: [] });
      expect(await runEndPhase(opts(WORKFLOW, { exitReason: "aborted" }), d)).toEqual({
        passed: false,
        reasons: ["run aborted"],
      });
      expect(workflow).toHaveLength(0);
    });
  });

  describe("runEndPhase hand-off figure (L4)", () => {
    test("the stories duration handed to the feature workflow comes from the injected clock", async () => {
      _endPhaseDeps.resolveBranch = async () => "feat/x";
      const { d, workflow } = deps({ passed: true, outcome: "ready", reasons: [] });
      await runEndPhase(opts(WORKFLOW, { startTime: 1_000 }), { ...d, now: () => 9_001_000 });
      expect(workflow[0]?.storiesDurationMs).toBe(9_000_000);
    });
  });
});
