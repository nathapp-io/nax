/**
 * Tests for session-runner.ts — keepOpen for implementer role.
 *
 * Uses injectable _sessionRunnerDeps instead of mock.module() to avoid
 * permanent module replacement that contaminates other test files.
 *
 * keepOpen is captured via sessionBinding.agentManager since Phase D removed
 * AgentAdapter.run() — the flag lives in AgentRunOptions (req.runOptions.keepOpen).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { IAgentManager } from "../../../src/agents/manager-types";
import type { AgentRunRequest } from "../../../src/agents/manager-types";
import type { UserStory } from "../../../src/prd";
import type { TddSessionBinding } from "../../../src/tdd/session-runner";
import { _sessionRunnerDeps, runTddSession } from "../../../src/tdd/session-runner";
import type { TddSessionRole } from "../../../src/tdd/types";
import { makeAgentAdapter, makeMockAgentManager, makeNaxConfig, makeSessionManager } from "../../helpers";

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
  } as unknown as UserStory;
}

function makeConfig(rectificationEnabled: boolean) {
  return makeNaxConfig({
    models: {
      claude: {
        fast: "fast-model",
        balanced: "balanced-model",
        powerful: "powerful-model",
      },
    },
    agent: { default: "claude" },
    execution: {
      rectification: rectificationEnabled
        ? { enabled: true, maxRetries: 2, fullSuiteTimeoutSeconds: 60, maxFailureSummaryChars: 1000 }
        : { enabled: false },
      sessionTimeoutSeconds: 300,
    },
    quality: { commands: { test: "bun test" } },
    tdd: { testWriterAllowedPaths: [] },
  });
}

/**
 * Creates a sessionBinding whose agentManager captures the keepOpen flag from
 * req.runOptions so tests can assert the value computed by session-runner.ts.
 */
function makeCapturingBinding(): {
  sessionBinding: TddSessionBinding;
  capturedKeepOpen: () => boolean | undefined;
} {
  let capturedKeepOpen: boolean | undefined;
  const agentManager = makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      capturedKeepOpen = req.runOptions.keepOpen;
      return {
        result: {
          success: true,
          exitCode: 0,
          output: "",
          rateLimited: false,
          durationMs: 0,
          estimatedCost: 0,
          agentFallbacks: [] as unknown[],
        },
        fallbacks: [],
      };
    },
  });
  const sessionMgr = makeSessionManager({
    runInSession: mock(async (_id: string, agentMgr: IAgentManager, request: AgentRunRequest) => {
      return agentMgr.run(request);
    }) as never,
  });
  return {
    sessionBinding: { sessionManager: sessionMgr, sessionId: "mock-session", agentManager },
    capturedKeepOpen: () => capturedKeepOpen,
  };
}

async function runSession(
  role: TddSessionRole,
  config: ReturnType<typeof makeNaxConfig>,
  sessionBinding: TddSessionBinding,
): Promise<void> {
  await runTddSession(
    role,
    makeAgentAdapter({ name: "claude" }) as never,
    makeStory(),
    config,
    "/tmp/fake",
    "balanced",
    "HEAD",
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sessionBinding,
  );
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
    const { sessionBinding, capturedKeepOpen } = makeCapturingBinding();
    await runSession("implementer", makeConfig(true), sessionBinding);
    expect(capturedKeepOpen()).toBe(true);
  });

  test("implementer sets keepOpen=false when rectification is disabled", async () => {
    const { sessionBinding, capturedKeepOpen } = makeCapturingBinding();
    await runSession("implementer", makeConfig(false), sessionBinding);
    expect(capturedKeepOpen()).toBe(false);
  });

  test("test-writer never sets keepOpen regardless of rectification config", async () => {
    const { sessionBinding, capturedKeepOpen } = makeCapturingBinding();
    await runSession("test-writer", makeConfig(true), sessionBinding);
    expect(capturedKeepOpen()).toBeFalsy();
  });

  test("verifier never sets keepOpen regardless of rectification config", async () => {
    const { sessionBinding, capturedKeepOpen } = makeCapturingBinding();
    await runSession("verifier", makeConfig(true), sessionBinding);
    expect(capturedKeepOpen()).toBeFalsy();
  });
});
