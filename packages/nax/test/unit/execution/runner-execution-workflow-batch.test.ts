import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  withTempDir,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { _captureDeps } from "@/execution/lifecycle/test-baseline-capture";
import type { RunnerExecutionOptions } from "@/execution/runner-execution";
import { runExecutionPhase } from "@/execution/runner-execution";
import { _unifiedExecutorDeps } from "@/execution/unified-executor";
import { effectiveUseBatch } from "@/execution/workflow-parallel";

const pipelineConfig = { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, mode: "pipeline" as const } };

const workflowConfig = { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, mode: "workflow" as const } };

describe("effectiveUseBatch", () => {
  test("pipeline mode passes the request through silently", () => {
    const warnings: string[] = [];
    expect(effectiveUseBatch(pipelineConfig, true, (m) => warnings.push(m))).toBe(true);
    expect(effectiveUseBatch(pipelineConfig, false, (m) => warnings.push(m))).toBe(false);
    expect(warnings).toEqual([]);
  });
  test("workflow mode forces false and warns once when batching was requested", () => {
    const warnings: string[] = [];
    expect(effectiveUseBatch(workflowConfig, true, (m) => warnings.push(m))).toBe(false);
    expect(warnings).toHaveLength(1);
  });
  test("workflow mode with batching already off stays silent", () => {
    const warnings: string[] = [];
    expect(effectiveUseBatch(workflowConfig, false, (m) => warnings.push(m))).toBe(false);
    expect(warnings).toEqual([]);
  });
});

const origRunIteration = _unifiedExecutorDeps.runIteration;
const origWriteBaseline = _captureDeps.writeRunBaseline;
afterEach(() => {
  _unifiedExecutorDeps.runIteration = origRunIteration;
  _captureDeps.writeRunBaseline = origWriteBaseline;
});

function simpleStory(id: string) {
  return makeStory({
    id,
    status: "pending",
    routing: { complexity: "simple", testStrategy: "test-after", reasoning: "fixture" },
  });
}

async function firstBatchSize(config: RunnerExecutionOptions["config"]): Promise<number> {
  return withTempDir(async (workdir) => {
    _captureDeps.writeRunBaseline = async () => {};
    const sizes: number[] = [];
    const prd = makePRD({ feature: "f", userStories: [simpleStory("US-001"), simpleStory("US-002")] });
    _unifiedExecutorDeps.runIteration = (async (_ctx, _prd, selection) => {
      sizes.push(selection.storiesToExecute.length);
      return {
        prd: makePRD({
          feature: "f",
          userStories: [makeStory({ id: "US-001", status: "passed" }), makeStory({ id: "US-002", status: "passed" })],
        }),
        storiesCompletedDelta: selection.storiesToExecute.length,
        costDelta: 0,
        prdDirty: false,
        finalAction: "continue",
      };
    }) as typeof _unifiedExecutorDeps.runIteration;
    const runtime = makeMockRuntime({ workdir });
    try {
      await runExecutionPhase(
        {
          prdPath: join(workdir, "prd.json"),
          workdir,
          config,
          hooks: { hooks: {}, _skipGlobal: false },
          feature: "f",
          dryRun: false,
          useBatch: true,
          statusWriter: makeStatusWriter(),
          statusFile: join(workdir, "status.json"),
          runId: "run-wf-batch",
          startedAt: new Date().toISOString(),
          startTime: Date.now(),
          formatterMode: "quiet",
          headless: false,
          parallel: undefined,
          abortSignal: new AbortController().signal,
          sessionManager: runtime.sessionManager,
          runtime,
          agentManager: runtime.agentManager,
          pluginProviderCache: undefined,
          providerWeightsCache: undefined,
        },
        prd,
        makePluginRegistry(),
      );
      return sizes[0] ?? 0;
    } finally {
      await runtime.close();
    }
  });
}

describe("runExecutionPhase batching", () => {
  test("pipeline mode batches consecutive simple stories (control)", async () => {
    expect(await firstBatchSize(makeNaxConfig({ execution: { mode: "pipeline", iterationDelayMs: 0 } }))).toBe(2);
  });
  test("workflow mode dispatches one story at a time", async () => {
    expect(await firstBatchSize(makeNaxConfig({ execution: { mode: "workflow", iterationDelayMs: 0 } }))).toBe(1);
  });
});
