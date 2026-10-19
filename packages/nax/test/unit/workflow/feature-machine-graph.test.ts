import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import { NaxError } from "@/errors";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { StepNode } from "@/step-graph";
import { FEATURE_GRAPH } from "@/workflow/feature-graph";
import type { FeatureEnv } from "@/workflow/feature-machine";
import { _featureMachineDeps, runFeatureMachine } from "@/workflow/feature-machine";
import type { FeatureStep, WorkflowFeatureRecord } from "@/workflow/types";

const originalRunner = _featureMachineDeps.runStepGraph;
afterEach(() => {
  _featureMachineDeps.runStepGraph = originalRunner;
  resetLogger();
});

describe("feature machine graph wiring", () => {
  test("delegates graph and record to the engine and returns its result", async () => {
    const { env } = makeFeatureMachineHarness({});
    const result = { ...env.record, outcome: "draft" as const };
    const calls: Parameters<typeof originalRunner>[] = [];
    _featureMachineDeps.runStepGraph = async (...args) => {
      calls.push(args);
      return result;
    };
    await expect(runFeatureMachine(env)).resolves.toBe(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual([FEATURE_GRAPH, env, env.record]);
    expect(calls[0]?.[4].costExceeded?.()).toBe(false);
  });

  test("wires hooks and runner options to the environment", async () => {
    const harness = makeFeatureMachineHarness({});
    const { env } = harness;
    const clockEnv = { ...env, now: () => 314, costExceeded: () => true };
    let captured: Parameters<typeof originalRunner> | undefined;
    _featureMachineDeps.runStepGraph = async (...args) => {
      captured = args;
      return args[2];
    };
    await runFeatureMachine(clockEnv);
    const args = captured;
    if (!args) throw new Error("runner arguments were not captured");
    const hooks = args[3];
    const options = args[4];
    const update = { ...env.record };
    await hooks.persist(update);
    hooks.onStep?.("publish", update);
    expect(options.aborted()).toBe(env.aborted());
    expect(options.now()).toBe(314);
    expect(options.costExceeded?.()).toBe(true);
    expect(options.logScope).toBeUndefined();
    const abort = options.onAbort?.("branch-fix");
    expect(abort).toBeInstanceOf(NaxError);
    expect(abort).toMatchObject({
      code: "WORKFLOW_ABORTED",
      message: "Run aborted during the feature workflow",
      context: { stage: "workflow", storyId: "_run", step: "branch-fix" },
    });
    expect(harness.updates).toEqual([update]);
    expect(harness.stepsSeen).toEqual(["publish"]);
  });

  test("readHead catches failures and emits the workflow warning", async () => {
    const { env } = makeFeatureMachineHarness({});
    const failingEnv = {
      ...env,
      steps: {
        ...env.steps,
        head: async () => {
          throw new Error("head unavailable");
        },
      },
    };
    let options: Parameters<typeof originalRunner>[4] | undefined;
    _featureMachineDeps.runStepGraph = async (...args) => {
      options = args[4];
      return args[2];
    };
    const entries: { level: string; stage: string; message: string; data?: Record<string, unknown> }[] = [];
    initLogger({ level: "warn", suppressConsole: true });
    addSink((entry) => entries.push(entry));
    await runFeatureMachine(failingEnv);
    const result = await options?.readHead?.();
    expect(result).toBeUndefined();
    expect(
      entries.filter(
        (entry) =>
          entry.level === "warn" &&
          entry.stage === "workflow" &&
          entry.message === "Could not read HEAD after a committing step; the record keeps the last one" &&
          entry.data?.storyId === "_run",
      ),
    ).toHaveLength(1);
  });

  test("abort and step failures preserve their specified behavior", async () => {
    const aborted = makeFeatureMachineHarness({}, { aborted: true });
    await expect(runFeatureMachine(aborted.env)).rejects.toMatchObject({
      code: "WORKFLOW_ABORTED",
      message: "Run aborted during the feature workflow",
      context: { stage: "workflow", storyId: "_run", step: "repo-gates" },
    });
    expect(aborted.calls).toEqual([]);
    expect(aborted.stepsSeen).toEqual([]);

    const failing = makeFeatureMachineHarness({});
    const failure = new Error("repo gates failed");
    failing.env.steps.repoGates = async () => {
      throw failure;
    };
    await expect(runFeatureMachine(failing.env)).rejects.toBe(failure);
    expect(failing.updates).toEqual([]);
    expect(failing.stepsSeen).toEqual(["repo-gates"]);
  });

  test("HEAD failure skips a branch fix and preserves the workflow log stage", async () => {
    const finding = { kind: "quality" as const, severity: "important" as const, issue: "must fix" };
    const review = {
      spec: "pass" as const,
      quality: "changes" as const,
      findings: [finding],
      cannotVerify: [],
      inspectedFiles: [],
      minorTriage: [],
    };
    const harness = makeFeatureMachineHarness({ review });
    harness.env.steps.head = async () => {
      throw new Error("head unavailable");
    };
    const entries: { level: string; stage: string; message: string; data?: Record<string, unknown> }[] = [];
    initLogger({ level: "warn", suppressConsole: true });
    addSink((entry) => entries.push(entry));
    const finalRecord = await runFeatureMachine(harness.env);
    expect(finalRecord.step).toBe("done");
    expect(harness.calls).not.toContain("branchFix");
    expect(harness.ledger).toContain("branch fix skipped: HEAD could not be read");
    expect(entries.filter((entry) => entry.level === "warn").every((entry) => entry.stage === "workflow")).toBe(true);
    expect(entries.some((entry) => entry.stage === "step-graph")).toBe(false);
  });

  test("resumed branch-fix retains lastHead when post-commit HEAD reads fail", async () => {
    const { env, updates, calls } = makeFeatureMachineHarness({});
    const record = {
      ...env.record,
      step: "branch-fix" as const,
      fixRan: true,
      fixRounds: 1,
      fixBase: "b1",
      lastHead: "h0",
      reviewOpen: [{ id: "B1", kind: "quality" as const, severity: "important" as const, issue: "fix me" }],
      fixTargets: ["B1"],
    };
    const resumed = {
      ...env,
      record,
      steps: {
        ...env.steps,
        head: async () => {
          throw new Error("HEAD unavailable");
        },
      },
    };
    const result = await runFeatureMachine(resumed);
    expect(calls.filter((call) => call === "branchFix")).toHaveLength(1);
    expect(result.step).toBe("done");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((update) => update.lastHead === "h0")).toBe(true);
  });

  test("engine rejects an undeclared output from a test-local graph copy", async () => {
    const { env } = makeFeatureMachineHarness({});
    const repoNode = FEATURE_GRAPH.nodes["repo-gates"];
    if (!repoNode) throw new Error("Missing repo-gates node");
    const illegalPatch = { reviewRan: true, unexpected: true };
    const badNode: StepNode<WorkflowFeatureRecord, FeatureEnv, FeatureStep> = {
      ...repoNode,
      run: async () => ({ patch: illegalPatch }),
    };
    const badGraph = { ...FEATURE_GRAPH, nodes: { ...FEATURE_GRAPH.nodes, "repo-gates": badNode } };
    _featureMachineDeps.runStepGraph = (_graph, graphEnv, record, hooks, options) =>
      originalRunner(badGraph, graphEnv, record, hooks, options);
    await expect(runFeatureMachine(env)).rejects.toMatchObject({ code: "STEP_GRAPH_UNDECLARED_OUTPUT" });
  });

  test("the actual engine rejects an unknown persisted cursor before doing workflow work", async () => {
    const { env, calls, stepsSeen, updates } = makeFeatureMachineHarness({});
    Object.defineProperty(env.record, "step", { value: "bogus" });
    await expect(runFeatureMachine(env)).rejects.toMatchObject({ code: "STEP_GRAPH_UNKNOWN_NODE" });
    expect(calls).toEqual([]);
    expect(stepsSeen).toEqual([]);
    expect(updates).toEqual([]);
  });
});
