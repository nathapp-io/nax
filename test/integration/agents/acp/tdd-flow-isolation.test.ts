/**
 * Integration tests: TDD three-session flow with AcpAgentAdapter (ACP-007)
 *
 * File: tdd-flow-isolation.test.ts
 * Covers:
 * - AC4: Isolation checks work correctly after ACP sessions
 * - AC5: Auto-commit is called after each session
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { withDepsRestore } from "../../../helpers/deps";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import type { AcpClient, AcpSession, AcpSessionResponse } from "../../../../src/agents/acp/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { NaxConfig } from "../../../../src/config";
import type { UserStory } from "../../../../src/prd";
import { _isolationDeps } from "../../../../src/tdd/isolation";
import { _sessionRunnerDeps, runTddSession } from "../../../../src/tdd/session-runner";
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

const config: NaxConfig = {
  ...DEFAULT_CONFIG,
  execution: {
    ...DEFAULT_CONFIG.execution,
    dangerouslySkipPermissions: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Deps restore
// ─────────────────────────────────────────────────────────────────────────────

withDepsRestore(_acpAdapterDeps, ["createClient", "sleep"]);
withDepsRestore(_gitDeps, ["spawn"]);
withDepsRestore(_sessionRunnerDeps, ["autoCommitIfDirty", "spawn"]);
withDepsRestore(_isolationDeps, ["spawn"]);
withDepsRestore(_executorDeps, ["spawn"]);

function mockGitSpawn(diffFileSequences: string[][] = []) {
  let revParseCount = 0;
  let diffCount = 0;

  _isolationDeps.spawn = mock((cmd: string[], spawnOpts?: unknown) => {
    if (cmd[0] === "git" && cmd[1] === "diff") {
      const files = diffFileSequences[diffCount] ?? [];
      diffCount++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(files.join("\n") + "\n").body,
        stderr: new Response("").body,
      };
    }
    return { exited: Promise.resolve(0), stdout: new Response("").body, stderr: new Response("").body };
  }) as any;

  const gitMock = mock((cmd: string[], spawnOpts?: unknown) => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      if (cmd[2] === "--show-toplevel") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response(((spawnOpts as any)?.cwd ?? ACP_WORKDIR) + "\n").body,
          stderr: new Response("").body,
        };
      }
      revParseCount++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(`ref-${revParseCount}\n`).body,
        stderr: new Response("").body,
      };
    }
    return {
      exited: Promise.resolve(0),
      stdout: new Response("").body,
      stderr: new Response("").body,
    };
  }) as any;

  _gitDeps.spawn = gitMock;
  _sessionRunnerDeps.spawn = gitMock;

  _executorDeps.spawn = mock((cmd: string[], spawnOpts?: unknown) => {
    return {
      pid: 9999,
      exited: Promise.resolve(0),
      stdout: new Response("1 pass, 0 fail\n").body,
      stderr: new Response("").body,
    };
  }) as any;
}

beforeEach(() => {
  _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
});

afterEach(() => {
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: Isolation checks work correctly after ACP sessions
// ─────────────────────────────────────────────────────────────────────────────

describe("isolation checks after ACP sessions", () => {
  test("test-writer isolation passes when only test files are modified", async () => {
    const session = makeSession(makeResponse({ stopReason: "end_turn" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
      ["test/feature.test.ts", "test/helper.test.ts"],
      ["test/feature.test.ts", "test/helper.test.ts"],
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "test-writer",
      adapter,
      story,
      config,
      ACP_WORKDIR,
      "balanced",
      "HEAD",
      undefined,
      false,
    );

    expect(result.isolation).toBeDefined();
    expect(result.isolation!.passed).toBe(true);
    expect(result.success).toBe(true);
  });

  test("test-writer isolation fails when source files are modified", async () => {
    const session = makeSession(makeResponse({ stopReason: "end_turn" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
      ["src/feature.ts", "test/feature.test.ts"],
      ["src/feature.ts", "test/feature.test.ts"],
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "test-writer",
      adapter,
      story,
      config,
      ACP_WORKDIR,
      "balanced",
      "HEAD",
      undefined,
      false,
    );

    expect(result.isolation).toBeDefined();
    expect(result.isolation!.passed).toBe(false);
    expect(result.success).toBe(false);
  });

  test("implementer isolation passes when only source files are modified", async () => {
    const session = makeSession(makeResponse({ stopReason: "end_turn" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
      ["src/feature.ts", "src/utils.ts"],
      ["src/feature.ts", "src/utils.ts"],
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "implementer",
      adapter,
      story,
      config,
      ACP_WORKDIR,
      "balanced",
      "HEAD",
      undefined,
      false,
    );

    expect(result.isolation).toBeDefined();
    expect(result.isolation!.passed).toBe(true);
    expect(result.success).toBe(true);
  });

  test("verifier uses implementer isolation check (only src files allowed)", async () => {
    const session = makeSession(makeResponse({ stopReason: "end_turn" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
      ["src/feature.ts"],
      ["src/feature.ts"],
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "verifier",
      adapter,
      story,
      config,
      ACP_WORKDIR,
      "balanced",
      "HEAD",
      undefined,
      false,
    );

    expect(result.isolation).toBeDefined();
    expect(result.isolation!.passed).toBe(true);
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: Auto-commit after each session still works
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-commit behavior after ACP sessions", () => {
  test("autoCommitIfDirty is invoked after each session via _sessionRunnerDeps", async () => {
    const session = makeSession(makeResponse({ stopReason: "end_turn" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    const autoCommitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    _sessionRunnerDeps.autoCommitIfDirty = mock(async (workdir, stage, role, storyId) => {
      autoCommitCalls.push({ workdir, stage, role, storyId });
    });

    mockGitSpawn([
      ["test/feature.test.ts"],
      ["test/feature.test.ts"],
    ]);

    const adapter = new AcpAgentAdapter("claude");
    await runTddSession(
      "test-writer",
      adapter,
      story,
      config,
      ACP_WORKDIR,
      "balanced",
      "HEAD",
      undefined,
      true,
    );

    expect(autoCommitCalls.length).toBeGreaterThanOrEqual(1);
    expect(autoCommitCalls[0].workdir).toBe(ACP_WORKDIR);
    expect(autoCommitCalls[0].stage).toBe("tdd");
    expect(autoCommitCalls[0].role).toBe("test-writer");
    expect(autoCommitCalls[0].storyId).toBe(story.id);
  });
});
