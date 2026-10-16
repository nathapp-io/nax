/**
 * The MCP adoption phase must aggregate THIS run's tool-audit files. Those files are
 * prefixed with `runtime.runId` (the dispatch UUID the coding tool writes under),
 * not the nax run id (`run-<hash>-<ts>`), so the phase has to receive the runtime's id.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeDispatchContext, makeNaxConfig, makeStatusWriter } from "@test/helpers";
import { _runCompletionDeps, handleRunCompletion, type RunCompletionOptions } from "@/execution/lifecycle";
import type { DeferredRegressionResult } from "@/execution/lifecycle/run-regression";
import type { PRD } from "@/prd";

const prd: PRD = {
  project: "p",
  feature: "feat",
  branchName: "b",
  createdAt: "t",
  updatedAt: "t",
  userStories: [],
};

describe("handleRunCompletion — MCP adoption run scoping", () => {
  const saved = { ..._runCompletionDeps };

  afterEach(() => {
    Object.assign(_runCompletionDeps, saved);
    mock.restore();
  });

  test("passes runtime.runId, the tool-audit file prefix, not the nax run id", async () => {
    const seen: Array<string | undefined> = [];
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        success: true,
        failedTests: 0,
        failedTestFiles: [],
        passedTests: 0,
        rectificationAttempts: 0,
        affectedStories: [],
      }),
    );
    _runCompletionDeps.summarizeMcpAdoptionPhase = mock(async (input: { toolAuditRunId: string | undefined }) => {
      seen.push(input.toolAuditRunId);
      return undefined;
    });
    const dispatch = makeDispatchContext();
    const options: RunCompletionOptions = {
      runId: "run-8a1b05ad-2026-10-16T02-34-36.372",
      feature: "feat",
      startedAt: new Date().toISOString(),
      prd,
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 0,
      iterations: 0,
      startTime: Date.now(),
      workdir: `/tmp/nax-test-mcp-adoption-${randomUUID()}`,
      statusWriter: makeStatusWriter(),
      config: makeNaxConfig(),
      ...dispatch,
    };

    await handleRunCompletion(options);

    expect(seen).toEqual([dispatch.runtime.runId]);
    expect(seen[0]).not.toBe(options.runId);
  });
});
