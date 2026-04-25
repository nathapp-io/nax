/**
 * Tests for session-runner.ts — keepOpen for implementer role.
 *
 * Uses injectable _sessionRunnerDeps instead of mock.module() to avoid
 * permanent module replacement that contaminates other test files.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult, AgentRunOptions } from "../../../src/agents/types";
import type { UserStory } from "../../../src/prd";
import { _sessionRunnerDeps, runTddSession } from "../../../src/tdd/session-runner";
import { makeNaxConfig } from "../../helpers";

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

function makeConfig(rectificationEnabled: boolean) {
  return makeNaxConfig({
    models: {
      claude: {
        fast: { model: "fast-model" },
        balanced: { model: "balanced-model" },
        powerful: { model: "powerful-model" },
      },
    },
    agent: { default: "claude" },
    execution: {
      rectification: rectificationEnabled
        ? { enabled: true, maxRetries: 2, fullSuiteTimeoutSeconds: 60, maxFailureSummaryChars: 1000 }
        : { enabled: false },
      sessionTimeoutSeconds: 300,
      dangerouslySkipPermissions: true,
    },
    quality: { commands: { test: "bun test" } },
    tdd: { testWriterAllowedPaths: [] },
  });
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
// Save/restore injectable deps — no mock.module() needed
// ─────────────────────────────────────────────────────────────────────────────

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

  // Mock all deps to no-ops
  _sessionRunnerDeps.autoCommitIfDirty = mock(async () => {});
  _sessionRunnerDeps.getChangedFiles = mock(async () => []);
  _sessionRunnerDeps.verifyTestWriterIsolation = mock(async () => ({ passed: true, violations: [], softViolations: [], description: "" }));
  _sessionRunnerDeps.verifyImplementerIsolation = mock(async () => ({ passed: true, violations: [], description: "" }));
  _sessionRunnerDeps.captureGitRef = mock(async () => "abc");
  _sessionRunnerDeps.cleanupProcessTree = mock(async () => {});
  _sessionRunnerDeps.buildPrompt = mock(async () => "mock prompt");
});

afterEach(() => {
  Object.assign(_sessionRunnerDeps, origDeps);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("session-runner implementer keepOpen", () => {
  test("implementer sets keepOpen=true when rectification is enabled", async () => {
    const agent = makeAgent();
    const config = makeConfig(true);

    await runTddSession("implementer", agent as any, makeStory(), config, "/tmp/fake", "balanced", "HEAD");

    expect(agent.capturedOpts?.keepOpen).toBe(true);
  });

  test("implementer sets keepOpen=false when rectification is disabled", async () => {
    const agent = makeAgent();
    const config = makeConfig(false);

    await runTddSession("implementer", agent as any, makeStory(), config, "/tmp/fake", "balanced", "HEAD");

    expect(agent.capturedOpts?.keepOpen).toBe(false);
  });

  test("test-writer never sets keepOpen regardless of rectification config", async () => {
    const agent = makeAgent();
    const config = makeConfig(true);

    await runTddSession("test-writer", agent as any, makeStory(), config, "/tmp/fake", "balanced", "HEAD");

    expect(agent.capturedOpts?.keepOpen).toBeFalsy();
  });

  test("verifier never sets keepOpen regardless of rectification config", async () => {
    const agent = makeAgent();
    const config = makeConfig(true);

    await runTddSession("verifier", agent as any, makeStory(), config, "/tmp/fake", "balanced", "HEAD");

    expect(agent.capturedOpts?.keepOpen).toBeFalsy();
  });
});
