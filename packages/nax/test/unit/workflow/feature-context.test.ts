import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestPRD, makeTestRuntime, makeTestStory } from "@test/helpers";
import { _featureContextDeps, buildFeatureContext } from "@/workflow/feature-context";
import { workflowRunDir } from "@/workflow/paths";

const original = { ..._featureContextDeps };
afterEach(() => Object.assign(_featureContextDeps, original));

describe("buildFeatureContext", () => {
  test("root-config CallContext with the ask wiring, stage merge, and the run's paths", async () => {
    const seen: Record<string, unknown>[] = [];
    let disposed = false;
    _featureContextDeps.buildRunDispatchAskWiring = async (opts) => {
      seen.push({ stage: opts.stage, featureName: opts.featureName, packageDirs: opts.packageDirs });
      return {
        askResolver: { resolve: async () => ({ decision: "deny", decidedBy: "unavailable", latencyMs: 0 }) },
        commandShadow: undefined,
        dispose: async () => {
          disposed = true;
        },
      };
    };
    const config = makeNaxConfig({ outputDir: "/out" });
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    const prd = makeTestPRD([
      makeTestStory({ id: "US-001", workdir: "packages/api" }),
      makeTestStory({ id: "US-002" }),
    ]);
    const { fc, dispose } = await buildFeatureContext({
      runtime,
      config,
      prd,
      feature: "f",
      workdir: "/repo",
      branch: "feat/x",
      runId: "r1",
      agentName: "claude",
    });
    expect(seen[0]).toEqual({ stage: "merge", featureName: "f", packageDirs: ["packages/api", undefined] });
    expect(fc.callCtx.featureName).toBe("f");
    expect(fc.callCtx.storyId).toBeUndefined();
    expect(fc.callCtx.askResolver).toBeDefined();
    expect(fc.runId).toBe(runtime.runId);
    expect(fc.runDir).toBe(`/repo/.nax/features/f/workflow/${runtime.runId}`);
    expect(fc.featureDir).toBe("/repo/.nax/features/f/workflow");
    expect(fc.prdPath).toBe("/repo/.nax/features/f/prd.json");
    expect(fc.reportPath).toBe(`/repo/.nax/features/f/workflow/${runtime.runId}/feature-report.md`);
    expect(fc.packageDirs).toEqual(["packages/api"]);
    await dispose();
    expect(disposed).toBe(true);
    await runtime.close();
  });

  test("one run = one folder: the feature context and the story loop share the run dir (nax#2482)", async () => {
    _featureContextDeps.buildRunDispatchAskWiring = async () => ({
      askResolver: { resolve: async () => ({ decision: "deny", decidedBy: "unavailable", latencyMs: 0 }) },
      commandShadow: undefined,
      dispose: async () => {},
    });
    const config = makeNaxConfig({ outputDir: "/out" });
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    const { fc, dispose } = await buildFeatureContext({
      runtime,
      config,
      prd: makeTestPRD([makeTestStory({ id: "US-001" })]),
      feature: "f",
      workdir: "/repo",
      branch: "feat/x",
      runId: "run-ask-wiring",
      agentName: "claude",
    });
    expect(fc.runDir).toBe(workflowRunDir("/repo", "f", runtime.runId));
    await dispose();
    await runtime.close();
  });
});
