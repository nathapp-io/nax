import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeFeatureContext } from "@test/helpers";
import { _featureDeps } from "@/workflow/feature-deps";
import { buildFeatureEnv } from "@/workflow/feature-env";
import { newFeatureRecord } from "@/workflow/feature-record";
import { _workflowDeps } from "@/workflow/step-context";
import { startTokenMeter } from "@/workflow/tokens";

const original = _featureDeps.forge;
const advisor = _workflowDeps.createAdvisor;
afterEach(() => {
  _featureDeps.forge = original;
  _workflowDeps.createAdvisor = advisor;
});

describe("buildFeatureEnv item-thread wiring", () => {
  test("AC-18 forge reads run in fc.projectDir and identity is explicitly captured", async () => {
    const fc = makeFeatureContext({ projectDir: "/explicit/repo", feature: "demo" });
    _workflowDeps.createAdvisor = () => ({
      advise: async () => ({ decision: null, fallbackReason: "off" }),
      recordReuse: async () => null,
      adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
    });
    const cwds: string[] = [];
    _featureDeps.forge = {
      readText: async () => null,
      run: async (_cmd, opts) => {
        cwds.push(opts.cwd);
        throw new Error("read stops here");
      },
    };
    const record = newFeatureRecord({ now: "t", seed: "seed", minors: [] });
    const env = buildFeatureEnv(
      fc,
      {
        runtime: fc.callCtx.runtime,
        config: fc.config,
        prd: fc.prd,
        feature: fc.feature,
        workdir: fc.projectDir,
        branch: fc.branch,
        runId: fc.runId,
        agentName: "native",
      },
      {
        stories: [],
        ledgerItems: { deferredMinors: [], cannotVerify: [], parked: [] },
        record,
        meter: startTokenMeter(undefined),
        preflight: null,
        specPath: "",
      },
    );
    expect(env.itemThreadsIdentity).toEqual({ projectDir: fc.projectDir, feature: fc.feature });
    const post = env.steps.postItemThreads;
    assertDefined(post);
    expect(
      await post({
        record,
        url: "https://github.com/o/r/pull/7",
        projectDir: "/wrong",
        feature: "wrong",
        changedFiles: [],
      }),
    ).toEqual({ posted: 0, closed: 0, skipped: 0, failed: 1 });
    expect(cwds).toEqual([fc.projectDir]);
  });
});
