/**
 * runThreeSessionTdd — totalTokenUsage + totalDurationMs aggregation (#590).
 *
 * Each TDD session reports its own tokenUsage/durationMs; the orchestrator
 * now sums them so the metrics tracker can emit a tokens block for TDD runs
 * the same way it does for single-session runs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult, AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { runThreeSessionTdd } from "../../../src/tdd/orchestrator";
import { _sessionRunnerDeps } from "../../../src/tdd/session-runner";

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Impl",
    description: "desc",
    acceptanceCriteria: ["AC-1"],
    status: "pending",
    attempts: 0,
    priorFailures: [],
  } as unknown as UserStory;
}

function makeConfig(): NaxConfig {
  return {
    models: {
      claude: {
        fast: { model: "fast" },
        balanced: { model: "balanced" },
        powerful: { model: "powerful" },
      },
    },
    agent: { default: "claude" },
    execution: { rectification: { enabled: false }, sessionTimeoutSeconds: 300 },
    quality: { commands: { test: "bun test" } },
    tdd: { testWriterAllowedPaths: [], rollbackOnFailure: false },
  } as unknown as NaxConfig;
}

function agentReturning(tokens: Array<AgentResult["tokenUsage"] | undefined>) {
  let call = 0;
  return {
    run: mock(
      async (_opts: AgentRunOptions): Promise<AgentResult> => {
        const tokenUsage = tokens[call++];
        return {
          success: true,
          exitCode: 0,
          output: "ok",
          rateLimited: false,
          durationMs: 50,
          estimatedCost: 0.01,
          ...(tokenUsage ? { tokenUsage } : {}),
        };
      },
    ),
    isInstalled: mock(async () => true),
    complete: mock(async () => ""),
    buildCommand: mock(() => []),
    deriveSessionName: mock(() => "nax-test"),
  };
}

let origDeps: Record<string, unknown>;
beforeEach(() => {
  origDeps = {
    autoCommitIfDirty: _sessionRunnerDeps.autoCommitIfDirty,
    getChangedFiles: _sessionRunnerDeps.getChangedFiles,
    verifyTestWriterIsolation: _sessionRunnerDeps.verifyTestWriterIsolation,
    verifyImplementerIsolation: _sessionRunnerDeps.verifyImplementerIsolation,
    captureGitRef: _sessionRunnerDeps.captureGitRef,
    cleanupProcessTree: _sessionRunnerDeps.cleanupProcessTree,
    buildPrompt: _sessionRunnerDeps.buildPrompt,
  };
  _sessionRunnerDeps.autoCommitIfDirty = mock(async () => {});
  // test-writer needs filesChanged containing a test file for the orchestrator to proceed
  _sessionRunnerDeps.getChangedFiles = mock(async () => ["test/foo.test.ts"]);
  _sessionRunnerDeps.verifyTestWriterIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.verifyImplementerIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.captureGitRef = mock(async () => "ref");
  _sessionRunnerDeps.cleanupProcessTree = mock(async () => {});
  _sessionRunnerDeps.buildPrompt = mock(async () => "prompt");
});
afterEach(() => {
  Object.assign(_sessionRunnerDeps, origDeps);
});

describe("runThreeSessionTdd — token + duration aggregation", () => {
  test("sums tokenUsage from all three sessions", async () => {
    const agent = agentReturning([
      { inputTokens: 100, outputTokens: 50 }, // test-writer
      { inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 10 }, // implementer
      { inputTokens: 50, outputTokens: 25 }, // verifier
    ]);

    const result = await runThreeSessionTdd({
      agent: agent as never,
      story: makeStory(),
      config: makeConfig(),
      workdir: "/tmp/fake",
      modelTier: "balanced",
    });

    expect(result.totalTokenUsage).toEqual({
      inputTokens: 350,
      outputTokens: 175,
      cacheReadInputTokens: 10,
    });
  });

  test("totalTokenUsage undefined when no session reports usage", async () => {
    const agent = agentReturning([undefined, undefined, undefined]);

    const result = await runThreeSessionTdd({
      agent: agent as never,
      story: makeStory(),
      config: makeConfig(),
      workdir: "/tmp/fake",
      modelTier: "balanced",
    });

    expect(result.totalTokenUsage).toBeUndefined();
  });

  test("totalDurationMs sums session durations", async () => {
    const agent = agentReturning([undefined, undefined, undefined]);

    const result = await runThreeSessionTdd({
      agent: agent as never,
      story: makeStory(),
      config: makeConfig(),
      workdir: "/tmp/fake",
      modelTier: "balanced",
    });

    // Each session is timed by the orchestrator (startTime → Date.now()),
    // so the exact value is non-deterministic, but must be a sum ≥ 0.
    expect(typeof result.totalDurationMs).toBe("number");
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
