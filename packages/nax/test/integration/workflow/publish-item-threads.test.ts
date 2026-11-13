import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeFeatureContext, makeNaxConfig } from "@test/helpers";
import { resolveWorkflowConfig } from "@/config";
import type { ForgeDeps } from "@/forge";
import { _featureDeps } from "@/workflow/feature-deps";
import { buildFeatureEnv } from "@/workflow/feature-env";
import { newFeatureRecord } from "@/workflow/feature-record";
import { _itemPublishPacerDeps } from "@/workflow/item-publish-pacer";
import { _workflowDeps } from "@/workflow/step-context";
import { startTokenMeter } from "@/workflow/tokens";

const original = _featureDeps.forge;
const realSleep = _itemPublishPacerDeps.sleep;
const advisor = _workflowDeps.createAdvisor;
afterEach(() => {
  _featureDeps.forge = original;
  _itemPublishPacerDeps.sleep = realSleep;
  _workflowDeps.createAdvisor = advisor;
});

/** The advisor no step here asks; wired so building the env needs no live model. */
function offlineAdvisor() {
  return {
    advise: async () => ({ decision: null, fallbackReason: "off" }),
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual" as const, items: [], diagnoses: {} }),
  };
}

/** A PR with no items and no index of its own, so the publish posts cleanly. */
function forgeStub(): ForgeDeps {
  const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
  const noThreads = {
    data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } },
  };
  return {
    readText: async () => null,
    run: async (cmd) => {
      if (cmd[0] === "git") return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
      if (cmd.includes("POST")) return ok({ id: 1 });
      if (cmd.includes("user")) return ok({ login: "bot", id: 1 });
      if (cmd.includes("graphql")) return ok(noThreads);
      if (cmd.some((arg) => arg.includes("?per_page="))) return ok([]);
      return ok({ head: { sha: "head", ref: "feature" }, base: { ref: "main" }, user: { login: "author" } });
    },
  };
}

function buildEnv(fc: ReturnType<typeof makeFeatureContext>, record: ReturnType<typeof newFeatureRecord>) {
  return buildFeatureEnv(
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
}

describe("buildFeatureEnv item-thread wiring", () => {
  test("AC-18 forge reads run in fc.projectDir and identity is explicitly captured", async () => {
    const fc = makeFeatureContext({ projectDir: "/explicit/repo", feature: "demo" });
    _workflowDeps.createAdvisor = offlineAdvisor;
    const cwds: string[] = [];
    _featureDeps.forge = {
      readText: async () => null,
      run: async (_cmd, opts) => {
        cwds.push(opts.cwd);
        throw new Error("read stops here");
      },
    };
    const record = newFeatureRecord({ now: "t", seed: "seed", minors: [] });
    const env = buildEnv(fc, record);
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
    ).toEqual({ posted: 0, closed: 0, skipped: 0, failed: 1, indexWritten: false, indexMissing: true });
    expect(cwds).toEqual([fc.projectDir]);
  });
  test("US-002 AC-10 the step passes workflow.itemPublish as the publish's pacing", async () => {
    const config = makeNaxConfig({ workflow: { itemPublish: { writeGapMs: 7 } } });
    const fc = makeFeatureContext({
      projectDir: "/explicit/repo",
      feature: "demo",
      config,
      workflow: resolveWorkflowConfig(config),
    });
    _workflowDeps.createAdvisor = offlineAdvisor;
    _featureDeps.forge = forgeStub();
    const sleeps: number[] = [];
    _itemPublishPacerDeps.sleep = async (ms) => {
      sleeps.push(ms);
    };
    const record = {
      ...newFeatureRecord({ now: "t", seed: "seed", minors: [] }),
      reviewOpen: [],
      cannotVerify: ["check the first one manually", "check the second one manually"],
    };
    const env = buildEnv(fc, record);
    const post = env.steps.postItemThreads;
    assertDefined(post);
    expect(
      await post({
        record,
        url: "https://github.com/o/r/pull/7",
        projectDir: "/wrong",
        feature: "wrong",
        changedFiles: ["a.ts"],
      }),
    ).toMatchObject({ posted: 2, failed: 0, indexWritten: true });
    // Two thread posts and the index write: the config's 7 ms gap between each pair.
    expect(sleeps).toEqual([7, 7]);
  });
});
