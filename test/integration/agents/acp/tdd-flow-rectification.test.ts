/**
 * Integration tests: TDD three-session flow with AcpAgentAdapter (ACP-007)
 *
 * File: tdd-flow-rectification.test.ts
 * Covers:
 * - AC3: TDD rectification gate works with AcpAgentAdapter
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { withDepsRestore } from "../../../helpers/deps";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { fakeAgentManager } from "../../../helpers/fake-agent-manager";
import type { AcpClient, AcpSession, AcpSessionResponse } from "../../../../src/agents/acp/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { NaxConfig } from "../../../../src/config";
import type { UserStory } from "../../../../src/prd";
import { _isolationDeps } from "../../../../src/tdd/isolation";
import { _rectificationGateDeps, runFullSuiteGate } from "../../../../src/tdd/rectification-gate";
import { _sessionRunnerDeps } from "../../../../src/tdd/session-runner";
import { _gitDeps } from "../../../../src/utils/git";
import { _executorDeps } from "../../../../src/verification/executor";

const ACP_WORKDIR = `/tmp/nax-acp-test-${randomUUID()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Mock factory helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeResponse(overrides: Partial<AcpSessionResponse> = {}): AcpSessionResponse {
  return {
    messages: [{ role: "assistant", content: "Task completed." }],
    stopReason: "end_turn",
    cumulative_token_usage: { input_tokens: 1000, output_tokens: 500 },
    ...overrides,
  };
}

function makeSession(response: AcpSessionResponse = makeResponse()): AcpSession & { promptCalls: string[] } {
  const promptCalls: string[] = [];
  return {
    promptCalls,
    prompt: mock(async (text: string) => {
      promptCalls.push(text);
      return response;
    }),
    close: mock(async () => {}),
    cancelActivePrompt: mock(async () => {}),
  };
}

function makeClient(session: AcpSession): AcpClient & {
  startCalled: number;
  sessionsCalled: number;
  closeCalled: number;
} {
  let startCalled = 0;
  let sessionsCalled = 0;
  let closeCalled = 0;
  return {
    get startCalled() {
      return startCalled;
    },
    get sessionsCalled() {
      return sessionsCalled;
    },
    get closeCalled() {
      return closeCalled;
    },
    start: mock(async () => {
      startCalled++;
    }),
    createSession: mock(async (_opts) => {
      sessionsCalled++;
      return session;
    }),
    close: mock(async () => {
      closeCalled++;
    }),
    cancelActivePrompt: mock(async () => {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const story: UserStory = {
  id: "ACP-007-test",
  title: "TDD flow via ACP",
  description: "Test TDD three-session flow with AcpAgentAdapter",
  acceptanceCriteria: ["Tests pass", "Implementation is correct"],
  dependencies: [],
  tags: ["tdd"],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Deps restore
// ─────────────────────────────────────────────────────────────────────────────

withDepsRestore(_acpAdapterDeps, ["createClient", "sleep"]);
withDepsRestore(_rectificationGateDeps, ["executeWithTimeout", "resolveTestCommands"]);
withDepsRestore(_gitDeps, ["spawn"]);
withDepsRestore(_sessionRunnerDeps, ["autoCommitIfDirty", "spawn"]);
withDepsRestore(_isolationDeps, ["spawn"]);
withDepsRestore(_executorDeps, ["spawn"]);

beforeEach(() => {
  _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
});

afterEach(() => {
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: TDD rectification gate works with AcpAgentAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("runFullSuiteGate with AcpAgentAdapter", () => {
  const rectificationConfig: NaxConfig = {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      dangerouslySkipPermissions: true,
      rectification: {
        enabled: true,
        maxRetries: 1,
        fullSuiteTimeoutSeconds: 30,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: false,
      },
    },
  };

  test("returns false when rectification is disabled", async () => {
    const disabledConfig: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification!,
          enabled: false,
        },
      },
    };

    const adapter = new AcpAgentAdapter("claude");

    _executorDeps.spawn = mock((cmd: string[]) => ({
      exited: Promise.resolve(0),
      stdout: new Response("").body,
      stderr: new Response("").body,
    })) as any;

    const result = await runFullSuiteGate(
      story,
      disabledConfig,
      ACP_WORKDIR,
      fakeAgentManager(adapter),
      "balanced",
      true,
      // biome-ignore lint/suspicious/noExplicitAny: test logger mock
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    );

    expect(result.passed).toBe(false);
  });

  test("returns true when full suite passes without regressions", async () => {
    const session = makeSession(makeResponse({ stopReason: "end_turn" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    _executorDeps.spawn = mock((cmd: string[], spawnOpts?: unknown) => {
      if ((cmd[0] === "/bin/sh" || cmd[0] === "/bin/bash") && cmd[1] === "-c") {
        return {
          pid: 9999,
          exited: Promise.resolve(0),
          stdout: new Response("1 pass, 0 fail\n").body,
          stderr: new Response("").body,
        };
      }
      return { exited: Promise.resolve(0), stdout: new Response("").body, stderr: new Response("").body };
    });

    const adapter = new AcpAgentAdapter("claude");
    const result = await runFullSuiteGate(
      story,
      rectificationConfig,
      ACP_WORKDIR,
      fakeAgentManager(adapter),
      "balanced",
      true,
      // biome-ignore lint/suspicious/noExplicitAny: test logger mock
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    );

    expect(result.passed).toBe(true);
  });

  test("calls agent.run() via AcpAgentAdapter during rectification loop", async () => {
    let clientsCreated = 0;
    _acpAdapterDeps.createClient = mock(() => {
      clientsCreated++;
      const session = makeSession(makeResponse({ stopReason: "end_turn" }));
      return makeClient(session);
    });

    _rectificationGateDeps.resolveTestCommands = mock(async () => ({
      rawTestCommand: "bun test",
      testCommand: "bun test",
      testScopedTemplate: undefined,
      isMonorepoOrchestrator: false,
      scopeFileThreshold: 10,
    }));
    let runCount = 0;
    _rectificationGateDeps.executeWithTimeout = mock(async (_cmd: string) => {
      runCount++;
      if (runCount === 1) {
        return {
          success: false,
          timeout: false,
          exitCode: 1,
          output: "test/feature.test.ts:\n✘ should work [1.0ms]\n(fail) suite > should work [1.0ms]\nError: boom\n",
          countsTowardEscalation: true,
        };
      }
      return {
        success: true,
        timeout: false,
        exitCode: 0,
        output: "test/feature.test.ts:\n✓ should work [1.0ms]\n",
        countsTowardEscalation: true,
      };
    });

    const adapter = new AcpAgentAdapter("claude");
    const result = await runFullSuiteGate(
      story,
      rectificationConfig,
      ACP_WORKDIR,
      fakeAgentManager(adapter),
      "balanced",
      true,
      // biome-ignore lint/suspicious/noExplicitAny: test logger mock
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    );

    expect(clientsCreated).toBeGreaterThanOrEqual(1);
    expect(result.passed).toBe(true);
  });

  test("rectification gate returns false after max retries with persistent failures", async () => {
    _acpAdapterDeps.createClient = mock(() => {
      const session = makeSession(makeResponse({ stopReason: "end_turn" }));
      return makeClient(session);
    });

    _rectificationGateDeps.resolveTestCommands = mock(async () => ({
      rawTestCommand: "bun test",
      testCommand: "bun test",
      testScopedTemplate: undefined,
      isMonorepoOrchestrator: false,
      scopeFileThreshold: 10,
    }));
    _rectificationGateDeps.executeWithTimeout = mock(async (_cmd: string) => ({
      success: false,
      timeout: false,
      exitCode: 1,
      output: "test/feature.test.ts:\n✘ should work [1.0ms]\n(fail) suite > should work [1.0ms]\nError: boom\n",
      countsTowardEscalation: true,
    }));

    const adapter = new AcpAgentAdapter("claude");
    const result = await runFullSuiteGate(
      story,
      rectificationConfig,
      ACP_WORKDIR,
      fakeAgentManager(adapter),
      "balanced",
      true,
      // biome-ignore lint/suspicious/noExplicitAny: test logger mock
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    );

    expect(result.passed).toBe(false);
  });
});
