/**
 * Tests for session-runner.ts — keepSessionOpen for implementer role.
 *
 * Covers:
 * - implementer passes keepSessionOpen=true when rectification is enabled
 * - implementer passes keepSessionOpen=false when rectification is disabled
 * - test-writer / verifier never set keepSessionOpen regardless of config
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult, AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { _sessionRunnerDeps, runTddSession } from "../../../src/tdd/session-runner";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Impl story",
    description: "Do the thing",
    acceptanceCriteria: ["AC-1"],
    status: "pending",
  };
}

function makeConfig(rectificationEnabled: boolean): NaxConfig {
  return {
    models: {
      fast: { model: "fast-model" },
      balanced: { model: "balanced-model" },
      powerful: { model: "powerful-model" },
    },
    execution: {
      rectification: rectificationEnabled
        ? { enabled: true, maxRetries: 2, fullSuiteTimeoutSeconds: 60, maxFailureSummaryChars: 1000 }
        : { enabled: false },
      sessionTimeoutSeconds: 300,
      dangerouslySkipPermissions: true,
    },
    quality: { commands: { test: "bun test" } },
    tdd: { testWriterAllowedPaths: [] },
  } as unknown as NaxConfig;
}

function makeAgent() {
  let capturedOpts: AgentRunOptions | null = null;
  const run = mock(async (opts: AgentRunOptions): Promise<AgentResult> => {
    capturedOpts = { ...opts };
    return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 100, estimatedCost: 0 };
  });
  return {
    run,
    get capturedOpts() {
      return capturedOpts;
    },
    isInstalled: mock(async () => true),
    complete: mock(async () => ""),
    buildCommand: mock(() => []),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup mocks for dependencies that session-runner calls after agent.run()
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Mock injectable deps
  _sessionRunnerDeps.autoCommitIfDirty = mock(async () => {});

  mock.module("../../../src/tdd/isolation", () => ({
    verifyTestWriterIsolation: mock(async () => ({ passed: true, violations: [] })),
    verifyImplementerIsolation: mock(async () => ({ passed: true, violations: [] })),
    getChangedFiles: mock(async () => []),
  }));
  mock.module("../../../src/tdd/cleanup", () => ({
    cleanupProcessTree: mock(async () => {}),
  }));
  mock.module("../../../src/utils/git", () => ({
    captureGitRef: mock(async () => "abc"),
  }));
  mock.module("../../../src/cli/prompts-tdd", () => ({
    PromptBuilder: {
      for: mock(() => ({
        withLoader: mock(() => ({
          story: mock(() => ({
            context: mock(() => ({
              constitution: mock(() => ({
                testCommand: mock(() => ({ build: mock(async () => "mock prompt") })),
              })),
            })),
          })),
        })),
      })),
    },
  }));
});

afterEach(() => {
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("session-runner implementer keepSessionOpen", () => {
  test("implementer sets keepSessionOpen=true when rectification is enabled", async () => {
    const agent = makeAgent();
    const config = makeConfig(true);

    await runTddSession("implementer", agent as any, makeStory(), config, "/tmp/fake", "balanced", "HEAD");

    expect(agent.capturedOpts?.keepSessionOpen).toBe(true);
  });

  test("implementer sets keepSessionOpen=false when rectification is disabled", async () => {
    const agent = makeAgent();
    const config = makeConfig(false);

    await runTddSession("implementer", agent as any, makeStory(), config, "/tmp/fake", "balanced", "HEAD");

    expect(agent.capturedOpts?.keepSessionOpen).toBe(false);
  });

  test("test-writer never sets keepSessionOpen regardless of rectification config", async () => {
    const agent = makeAgent();
    const config = makeConfig(true);

    await runTddSession("test-writer", agent as any, makeStory(), config, "/tmp/fake", "balanced", "HEAD");

    expect(agent.capturedOpts?.keepSessionOpen).toBeFalsy();
  });

  test("verifier never sets keepSessionOpen regardless of rectification config", async () => {
    const agent = makeAgent();
    const config = makeConfig(true);

    await runTddSession("verifier", agent as any, makeStory(), config, "/tmp/fake", "balanced", "HEAD");

    expect(agent.capturedOpts?.keepSessionOpen).toBeFalsy();
  });
});
