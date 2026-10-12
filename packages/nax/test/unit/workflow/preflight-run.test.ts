import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeFeatureContext,
  makeNaxConfig,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
} from "@test/helpers";
import type { Advisor, BatchRequest } from "@/advisor";
import type { NaxRuntime } from "@/runtime";
import { preflightPath } from "@/workflow/preflight";
import { _preflightRunDeps, adoptPriorPreflight, runWorkflowPreflight } from "@/workflow/preflight-run";
import { newStoryRecord, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";

const originalRun = { ..._preflightRunDeps };
const originalWf = { ..._workflowDeps };
const dirs: string[] = [];
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_preflightRunDeps, originalRun);
  Object.assign(_workflowDeps, originalWf);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function setup(opts: { preflight?: boolean; batchThrows?: boolean } = {}) {
  const out = makeTempDir("wf-pfr-");
  dirs.push(out);
  const config = makeNaxConfig({ outputDir: out, workflow: { preflight: opts.preflight ?? true } });
  const runtime = makeTestRuntime({ config, workdir: "/repo" });
  runtimes.push(runtime);
  const featureDir = join(out, "workflow", "f");
  const runDir = join(featureDir, "r-now");
  _preflightRunDeps.buildFeatureContext = async () => ({
    fc: makeFeatureContext({ featureDir, runDir, runId: "r-now" }),
    dispose: async () => {},
  });
  const calls: BatchRequest[] = [];
  const advisor: Advisor = {
    advise: async () => ({ decision: null }),
    recordReuse: async () => null,
    adviseBatch: async (req) => {
      calls.push(req);
      if (opts.batchThrows) throw new Error("ladder down");
      return { kind: "preflight", overlap: [], items: [] };
    },
  };
  _workflowDeps.createAdvisor = () => advisor;
  const prd = makeTestPRD([
    makeTestStory({ id: "US-001" }),
    makeTestStory({ id: "US-002", status: "passed", passes: true }),
    makeTestStory({ id: "US-003", status: "skipped" }),
  ]);
  const input = { runtime, config, prd, feature: "f", workdir: "/repo", runId: "r-now", agentName: "claude" };
  return { input, calls, runDir, featureDir };
}

describe("runWorkflowPreflight (P4-R14)", () => {
  test("one batch over the stories not yet passed or skipped; preflight.json written", async () => {
    const { input, calls, runDir } = setup();
    await runWorkflowPreflight(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "preflight", storyIds: ["US-001"] });
    expect(await Bun.file(preflightPath(runDir)).exists()).toBe(true);
  });

  test("workflow.preflight false -> nothing", async () => {
    const { input, calls } = setup({ preflight: false });
    await runWorkflowPreflight(input);
    expect(calls).toHaveLength(0);
  });

  test("a reusable preflight.json from an earlier run is adopted: no second batch", async () => {
    const { input, calls, featureDir, runDir } = setup();
    const old = join(featureDir, "r-old");
    await upsertStoryRecord(old, { runId: "r-old", feature: "f" }, newStoryRecord("US-001", 5, "t"));
    await Bun.write(preflightPath(old), JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [] }));
    await runWorkflowPreflight(input);
    expect(calls).toHaveLength(0);
    expect(await Bun.file(preflightPath(runDir)).json()).toEqual({ schemaVersion: 1, overlap: [], conflicts: [] });
  });

  test("fail-open: an advisor failure never throws", async () => {
    const { input } = setup({ batchThrows: true });
    await expect(runWorkflowPreflight(input)).resolves.toBeUndefined();
  });
});

describe("adoptPriorPreflight", () => {
  test("never overwrites this run's own file", async () => {
    const { featureDir, runDir } = setup();
    await Bun.write(
      preflightPath(runDir),
      JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [], mine: true }),
    );
    expect(await adoptPriorPreflight(featureDir, runDir)).toBe(false);
  });
});
