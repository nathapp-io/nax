import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFeatureContext, makeTempDir } from "@test/helpers";
import type { Advisor } from "@/advisor";
import { buildFeatureEnv } from "@/workflow/feature-env";
import { newFeatureRecord } from "@/workflow/feature-record";
import { readResult } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";
import { startTokenMeter } from "@/workflow/tokens";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const noDecisions: Advisor = {
  advise: async () => ({ decision: null, fallbackReason: "off" }),
  recordReuse: async () => null,
  adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
};

function setup() {
  const runDir = makeTempDir("wf-env-");
  dirs.push(runDir);
  _workflowDeps.createAdvisor = () => noDecisions;
  const fc = makeFeatureContext({ runDir });
  const blocks: unknown[] = [];
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
      agentName: "claude",
      statusWriter: { setWorkflowStatus: (b) => blocks.push(b) },
    },
    {
      stories: [{ id: "US-001", title: "A", state: "complete", rounds: 2, unreviewed: false, flagged: 0 }],
      ledgerItems: { deferredMinors: [], cannotVerify: [], parked: [] },
      record: {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        tokensByRole: { "wf-implementer": { inputTokens: 1, outputTokens: 1, costUsd: 1, calls: 1 } },
      },
      meter: startTokenMeter(undefined),
      preflight: null,
      specPath: "",
    },
  );
  return { fc, env, blocks };
}

describe("buildFeatureEnv", () => {
  test("sink.update writes featureWorkflow into this run's result.json, keeping prior tokens", async () => {
    const { fc, env } = setup();
    await env.sink.update({ ...env.record, step: "branch-review" });
    const file = await readResult(fc.runDir);
    expect(file?.featureWorkflow?.step).toBe("branch-review");
    expect(file?.featureWorkflow?.tokensByRole["wf-implementer"]?.calls).toBe(1);
  });

  test("sink.step sets the status.json workflow block", () => {
    const { env, blocks } = setup();
    env.sink.step("publish", { ...env.record, outcome: "draft", url: "u" });
    expect(blocks).toEqual([
      { step: "publish", stories: { "US-001": { state: "complete", round: 2 } }, outcome: "draft", url: "u" },
    ]);
  });

  test("adjudicate is feature-scoped: default holds land as _run ledger lines (P4-R18)", async () => {
    const { fc, env } = setup();
    const rulings = await env.steps.adjudicate([{ id: "B1", kind: "quality", severity: "important", issue: "drift" }]);
    expect(rulings).toHaveLength(1);
    expect(rulings[0]?.action).toBe("hold");
    expect(await Bun.file(join(fc.runDir, "ledger.md")).text()).toContain("_run: Ruling: hold B1: drift");
  });
});
