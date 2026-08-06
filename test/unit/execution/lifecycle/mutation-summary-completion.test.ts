import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type RunnerCompletionOptions, runCompletionPhase } from "@/execution";
import type { MutationStorySummary } from "@/runtime";
import { makeMockRuntime, makeNaxConfig } from "@test/helpers";

const survivor = {
  file: "src/survivor.ts",
  line: 9,
  before: "+",
  after: "-",
  operatorId: "ts:arith-add-sub",
  outcome: "survived" as const,
};

function makeSummary(): MutationStorySummary {
  return { storyId: "US-007", survivors: [survivor], outcomes: { killed: 0, survived: 1, errored: 0 } };
}

describe("runCompletionPhase mutation survivor reporting", () => {
  let logSpy: ReturnType<typeof mock>;
  let originalLog: typeof console.log;

  beforeEach(() => {
    originalLog = console.log;
    logSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
  });

  afterEach(() => {
    console.log = originalLog;
  });

  function makeOptions(formatterMode: "normal" | "json", summaries = [makeSummary()]): RunnerCompletionOptions {
    const runtime = makeMockRuntime();
    for (const summary of summaries) runtime.mutationSummaries.set(summary.storyId, summary);
    return {
      config: makeNaxConfig({ acceptance: { enabled: false } }),
      hooks: { hooks: {}, _skipGlobal: false },
      feature: "test-feature",
      workdir: "/tmp/test",
      statusFile: "/tmp/test/status.json",
      runId: "run-001",
      startedAt: new Date().toISOString(),
      startTime: Date.now(),
      formatterMode,
      headless: true,
      prd: { userStories: [] },
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 0,
      iterations: 1,
      statusWriter: {
        setPrd: () => {},
        setCurrentStory: () => {},
        setRunStatus: () => {},
        setPostRunPhase: () => {},
        update: async () => {},
        getPostRunStatus: () => undefined,
        writeFeatureStatus: async () => {},
      },
      pluginRegistry: { getAll: () => [], get: () => undefined },
      prdPath: "/tmp/test/prd.json",
      runtime,
    } as unknown as RunnerCompletionOptions;
  }

  test("US-004 AC11: prints survivors in headless normal mode", async () => {
    await runCompletionPhase(makeOptions("normal"));
    expect(logSpy.mock.calls.flat().join(" ")).toContain("src/survivor.ts");
  });

  test("US-004 AC12: stays silent about survivors in headless json mode", async () => {
    await runCompletionPhase(makeOptions("json"));
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain("src/survivor.ts");
  });

  test("US-004 AC13: does not print a mutation heading without survivors", async () => {
    await runCompletionPhase(makeOptions("normal", []));
    expect(logSpy.mock.calls.flat().join(" ").toLowerCase()).not.toContain("surviving mutant");
  });

  test("US-004 AC14: logs the survivor count at run completion", async () => {
    const options = makeOptions("json");
    const warning = mock(() => {});
    options.runtime.logger.warn = warning;

    await runCompletionPhase(options);
    expect(warning.mock.calls.some((call) => (call[2] as Record<string, unknown>)?.survivorCount === 1)).toBe(true);
  });
});
