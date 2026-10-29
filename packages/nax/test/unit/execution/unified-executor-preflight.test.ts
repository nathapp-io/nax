import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeDispatchContext, makePluginRegistry, makePRD, makeStatusWriter, makeTestRuntime } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { stopHeartbeat } from "@/execution/crash-recovery";
import { _unifiedExecutorDeps, executeUnified, type SequentialExecutionContext } from "@/execution/unified-executor";
import type { NaxRuntime } from "@/runtime";
import type { WorkflowRunStartInput } from "@/workflow";

const WORKDIR = `/tmp/nax-wf-preflight-${randomUUID()}`;
const origDeps = { ..._unifiedExecutorDeps };
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_unifiedExecutorDeps, origDeps);
  stopHeartbeat();
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});

function configFor(mode: "pipeline" | "workflow") {
  return {
    ...DEFAULT_CONFIG,
    acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
    execution: { ...DEFAULT_CONFIG.execution, mode, maxIterations: 0, iterationDelayMs: 0 },
  };
}

async function run(mode: "pipeline" | "workflow", dryRun = false): Promise<WorkflowRunStartInput[]> {
  const seen: WorkflowRunStartInput[] = [];
  _unifiedExecutorDeps.runWorkflowPreflight = async (input) => {
    seen.push(input);
  };
  // Workflow mode ignores maxIterations (nax#2706), so its loop runs: settle every story without touching disk.
  _unifiedExecutorDeps.runIteration = async (_ctx, prd) => ({
    prd: { ...prd, userStories: prd.userStories.map((s) => ({ ...s, status: "passed", passes: true })) },
    storiesCompletedDelta: prd.userStories.length,
    costDelta: 0,
    prdDirty: false,
  });
  const config = configFor(mode);
  const runtime = makeTestRuntime({ config });
  runtimes.push(runtime);
  const ctx: SequentialExecutionContext = {
    prdPath: `${WORKDIR}/prd.json`,
    workdir: WORKDIR,
    config,
    hooks: { hooks: {} },
    feature: "f",
    dryRun,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "run-pf",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    ...makeDispatchContext({ runtime }),
  };
  await executeUnified(ctx, makePRD({ feature: "f" }));
  return seen;
}

describe("executeUnified — workflow pre-flight placement (spec §5.3, P4-R14)", () => {
  test("workflow mode: called once with the run's prd, feature, run id and agent", async () => {
    const seen = await run("workflow");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ feature: "f", runId: "run-pf", workdir: WORKDIR });
    expect(typeof seen[0]?.agentName).toBe("string");
  });

  test("pipeline mode and dry runs: never called", async () => {
    expect(await run("pipeline")).toHaveLength(0);
    expect(await run("workflow", true)).toHaveLength(0);
  });
});
