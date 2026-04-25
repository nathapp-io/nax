/**
 * runTddSession — token usage propagation (#590) and state transitions (#589).
 *
 * Phase 2: TDD sessions now route through SessionManager.runInSession so:
 *   - tokenUsage from AgentResult is returned on TddSessionResult.tokenUsage
 *   - descriptor state advances CREATED → RUNNING → COMPLETED automatically
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult, AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { SessionManager } from "../../../src/session/manager";
import { _sessionRunnerDeps, runTddSession } from "../../../src/tdd/session-runner";

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Impl story",
    description: "Do the thing",
    acceptanceCriteria: ["AC-1"],
    status: "pending",
  } as unknown as UserStory;
}

function makeConfig(): NaxConfig {
  return {
    models: {
      claude: {
        fast: { model: "fast-model" },
        balanced: { model: "balanced-model" },
        powerful: { model: "powerful-model" },
      },
    },
    agent: { default: "claude" },
    execution: { rectification: { enabled: false }, sessionTimeoutSeconds: 300, dangerouslySkipPermissions: true },
    quality: { commands: { test: "bun test" } },
    tdd: { testWriterAllowedPaths: [] },
  } as unknown as NaxConfig;
}

function makeAgent(result: Partial<AgentResult>) {
  return {
    run: mock(
      async (_opts: AgentRunOptions): Promise<AgentResult> => ({
        success: true,
        exitCode: 0,
        output: "done",
        rateLimited: false,
        durationMs: 100,
        estimatedCost: 0.05,
        ...result,
      }),
    ),
    isInstalled: mock(async () => true),
    complete: mock(async () => ""),
    buildCommand: mock(() => []),
    deriveSessionName: mock(() => "nax-abc12345-feat-US-001-implementer"),
  };
}

let origDeps: Record<string, unknown>;

beforeEach(() => {
  origDeps = {
    autoCommitIfDirty: _sessionRunnerDeps.autoCommitIfDirty,
    getChangedFiles: _sessionRunnerDeps.getChangedFiles,
    verifyImplementerIsolation: _sessionRunnerDeps.verifyImplementerIsolation,
    verifyTestWriterIsolation: _sessionRunnerDeps.verifyTestWriterIsolation,
    captureGitRef: _sessionRunnerDeps.captureGitRef,
    cleanupProcessTree: _sessionRunnerDeps.cleanupProcessTree,
    buildPrompt: _sessionRunnerDeps.buildPrompt,
  };
  _sessionRunnerDeps.autoCommitIfDirty = mock(async () => {});
  _sessionRunnerDeps.getChangedFiles = mock(async () => []);
  _sessionRunnerDeps.verifyImplementerIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.verifyTestWriterIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.captureGitRef = mock(async () => "abc");
  _sessionRunnerDeps.cleanupProcessTree = mock(async () => {});
  _sessionRunnerDeps.buildPrompt = mock(async () => "mock prompt");
});

afterEach(() => {
  Object.assign(_sessionRunnerDeps, origDeps);
});

describe("runTddSession — tokenUsage (#590)", () => {
  test("propagates tokenUsage from AgentResult to TddSessionResult", async () => {
    const agent = makeAgent({
      tokenUsage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 500 },
    });

    const outcome = await runTddSession(
      "implementer",
      agent as never,
      makeStory(),
      makeConfig(),
      "/tmp/fake",
      "balanced",
      "HEAD",
    );

    expect(outcome.tokenUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 500,
    });
  });

  test("tokenUsage is undefined when the agent reports none", async () => {
    const agent = makeAgent({}); // no tokenUsage field

    const outcome = await runTddSession(
      "verifier",
      agent as never,
      makeStory(),
      makeConfig(),
      "/tmp/fake",
      "balanced",
      "HEAD",
    );

    expect(outcome.tokenUsage).toBeUndefined();
  });
});

describe("runTddSession — state transitions via runInSession (#589)", () => {
  test("advances descriptor CREATED → RUNNING → COMPLETED on success", async () => {
    const mgr = new SessionManager();
    const descriptor = mgr.create({ role: "implementer", agent: "claude", workdir: "/tmp/fake", handle: "nax-test" });
    expect(mgr.get(descriptor.id)?.state).toBe("CREATED");

    const agent = makeAgent({});
    await runTddSession(
      "implementer",
      agent as never,
      makeStory(),
      makeConfig(),
      "/tmp/fake",
      "balanced",
      "HEAD",
      undefined, // contextMarkdown
      false, // lite
      false, // skipIsolation
      undefined, // constitution
      "feat", // featureName
      undefined, // interactionBridge
      undefined, // projectDir
      undefined, // featureContextMarkdown
      undefined, // contextBundle
      { sessionManager: mgr, sessionId: descriptor.id },
    );

    expect(mgr.get(descriptor.id)?.state).toBe("COMPLETED");
  });

  test("advances descriptor to FAILED when agent returns success=false", async () => {
    const mgr = new SessionManager();
    const descriptor = mgr.create({ role: "implementer", agent: "claude", workdir: "/tmp/fake", handle: "nax-test" });

    const agent = makeAgent({ success: false, exitCode: 1 });
    await runTddSession(
      "implementer",
      agent as never,
      makeStory(),
      makeConfig(),
      "/tmp/fake",
      "balanced",
      "HEAD",
      undefined,
      false,
      false,
      undefined,
      "feat",
      undefined,
      undefined,
      undefined,
      undefined,
      { sessionManager: mgr, sessionId: descriptor.id },
    );

    expect(mgr.get(descriptor.id)?.state).toBe("FAILED");
  });
});
