import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import { FEATURE_GRAPH } from "@/workflow/feature-graph";
import { _featureMachineDeps, runFeatureMachine } from "@/workflow/feature-machine";

const originalRunner = _featureMachineDeps.runStepGraph;
afterEach(() => {
  _featureMachineDeps.runStepGraph = originalRunner;
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
  });

  test("wires hooks and runner options to the environment", async () => {
    const harness = makeFeatureMachineHarness({});
    const { env } = harness;
    let captured: Parameters<typeof originalRunner> | undefined;
    _featureMachineDeps.runStepGraph = async (...args) => {
      captured = args;
      return args[2];
    };
    await runFeatureMachine(env);
    const args = captured;
    if (!args) throw new Error("runner arguments were not captured");
    const hooks = args[3];
    const options = args[4];
    const update = { ...env.record };
    await hooks.persist(update);
    hooks.onStep?.("publish", update);
    expect(options.aborted()).toBe(env.aborted());
    expect(options.costExceeded?.()).toBe(false);
    expect(options.logScope).toBeUndefined();
    expect(harness.updates).toEqual([update]);
    expect(harness.stepsSeen).toEqual(["publish"]);
  });

  test("the actual engine rejects an unknown persisted cursor before doing workflow work", async () => {
    const { env, calls, stepsSeen } = makeFeatureMachineHarness({});
    const invalidEnv = { ...env, record: { ...env.record, step: "bogus" as string as typeof env.record.step } };
    await expect(runFeatureMachine(invalidEnv)).rejects.toMatchObject({ code: "STEP_GRAPH_UNKNOWN_NODE" });
    expect(calls).toEqual([]);
    expect(stepsSeen).toEqual([]);
  });
});
