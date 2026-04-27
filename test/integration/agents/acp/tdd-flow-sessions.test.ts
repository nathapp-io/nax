/**
 * Integration tests: TDD three-session flow with AcpAgentAdapter (ACP-007)
 *
 * File: tdd-flow-sessions.test.ts
 * Covers:
 * - AC1: TDD three-session flow works with AcpAgentAdapter
 * - AC2: Each TDD session creates its own independent ACP session (3 total)
 * - AC6: Cost tracking accumulates correctly from cumulative_token_usage
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
// Git spawn mock
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
// AC1: TDD three-session flow works with AcpAgentAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("runTddSession with AcpAgentAdapter", () => {
  test("test-writer session completes successfully via AcpAgentAdapter", async () => {
    const session = makeSession(
      makeResponse({ stopReason: "end_turn", cumulative_token_usage: { input_tokens: 1000, output_tokens: 500 } }),
    );
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
      ["test/feature.test.ts"],
      ["test/feature.test.ts"],
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
      true,
    );

    expect(result.success).toBe(true);
    expect(result.role).toBe("test-writer");
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  test("implementer session completes successfully via AcpAgentAdapter", async () => {
    const session = makeSession(
      makeResponse({ stopReason: "end_turn", cumulative_token_usage: { input_tokens: 2000, output_tokens: 800 } }),
    );
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
      ["src/feature.ts"],
      ["src/feature.ts"],
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
      true,
    );

    expect(result.success).toBe(true);
    expect(result.role).toBe("implementer");
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  test("verifier session completes successfully via AcpAgentAdapter", async () => {
    const session = makeSession(
      makeResponse({ stopReason: "end_turn", cumulative_token_usage: { input_tokens: 1500, output_tokens: 600 } }),
    );
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
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
      true,
    );

    expect(result.success).toBe(true);
    expect(result.role).toBe("verifier");
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  test("failed agent response maps to session failure", async () => {
    const session = makeSession(makeResponse({ stopReason: "error" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([[], []]);

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
      true,
    );

    expect(result.success).toBe(false);
    expect(result.role).toBe("test-writer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: Each TDD session creates its own ACP session (3 total per story)
// ─────────────────────────────────────────────────────────────────────────────

describe("three-session flow creates 3 independent ACP sessions", () => {
  test("each runTddSession call creates a new AcpClient and session", async () => {
    const clients: ReturnType<typeof makeClient>[] = [];

    _acpAdapterDeps.createClient = mock(() => {
      const s = makeSession();
      const c = makeClient(s);
      clients.push(c);
      return c;
    });

    mockGitSpawn([
      ["test/feature.test.ts"],
      ["test/feature.test.ts"],
      ["src/feature.ts"],
      ["src/feature.ts"],
      ["src/feature.ts"],
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const roles = ["test-writer", "implementer", "verifier"] as const;

    for (const role of roles) {
      await runTddSession(role, adapter, story, config, ACP_WORKDIR, "balanced", "HEAD", undefined, true);
    }

    expect(clients).toHaveLength(3);
    for (const c of clients) {
      expect(c.startCalled).toBe(1);
      expect(c.sessionsCalled).toBe(1);
      expect(c.closeCalled).toBe(1);
    }
  });

  test("sessions are independent — one session failing does not affect others", async () => {
    const responses = [
      makeResponse({ stopReason: "end_turn" }),
      makeResponse({ stopReason: "error" }),
      makeResponse({ stopReason: "end_turn" }),
    ];
    let callIndex = 0;

    _acpAdapterDeps.createClient = mock(() => {
      const session = makeSession(responses[callIndex++]);
      return makeClient(session);
    });

    mockGitSpawn([
      ["test/feature.test.ts"],
      ["test/feature.test.ts"],
      ["src/feature.ts"],
      ["src/feature.ts"],
      ["src/feature.ts"],
    ]);

    const adapter = new AcpAgentAdapter("claude");

    const twResult = await runTddSession(
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
    const implResult = await runTddSession(
      "implementer",
      adapter,
      story,
      config,
      ACP_WORKDIR,
      "balanced",
      "HEAD",
      undefined,
      true,
    );
    const verResult = await runTddSession(
      "verifier",
      adapter,
      story,
      config,
      ACP_WORKDIR,
      "balanced",
      "HEAD",
      undefined,
      true,
    );

    expect(twResult.success).toBe(true);
    expect(implResult.success).toBe(false);
    expect(verResult.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: Cost tracking accumulates correctly across 3 ACP sessions
// ─────────────────────────────────────────────────────────────────────────────

describe("cost tracking across 3 ACP sessions", () => {
  test("each session reports cost from cumulative_token_usage", async () => {
    const tokenSets = [
      { input_tokens: 1000, output_tokens: 500 },
      { input_tokens: 2000, output_tokens: 800 },
      { input_tokens: 1500, output_tokens: 600 },
    ];
    let callIndex = 0;

    _acpAdapterDeps.createClient = mock(() => {
      const usage = tokenSets[callIndex++];
      const session = makeSession(makeResponse({ stopReason: "end_turn", cumulative_token_usage: usage }));
      return makeClient(session);
    });

    mockGitSpawn([
      ["test/feature.test.ts"],
      ["test/feature.test.ts"],
      ["src/feature.ts"],
      ["src/feature.ts"],
      ["src/feature.ts"],
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const costs: number[] = [];

    for (const role of ["test-writer", "implementer", "verifier"] as const) {
      const result = await runTddSession(
        role,
        adapter,
        story,
        config,
        ACP_WORKDIR,
        "balanced",
        "HEAD",
        undefined,
        true,
      );
      costs.push(result.estimatedCostUsd);
    }

    expect(costs[0]).toBeGreaterThan(0);
    expect(costs[1]).toBeGreaterThan(0);
    expect(costs[2]).toBeGreaterThan(0);
    expect(costs[1]).toBeGreaterThan(costs[0]);

    const totalCost = costs.reduce((sum, c) => sum + c, 0);
    expect(totalCost).toBeGreaterThan(0);
  });

  test("zero token usage returns zero cost", async () => {
    const session = makeSession(
      makeResponse({ stopReason: "end_turn", cumulative_token_usage: { input_tokens: 0, output_tokens: 0 } }),
    );
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([["test/feature.test.ts"], ["test/feature.test.ts"]]);

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
      true,
    );

    expect(result.estimatedCostUsd).toBe(0);
  });

  test("missing token usage returns zero cost", async () => {
    const session = makeSession(
      makeResponse({ stopReason: "end_turn", cumulative_token_usage: undefined }),
    );
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([["test/feature.test.ts"], ["test/feature.test.ts"]]);

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
      true,
    );

    expect(result.estimatedCostUsd).toBe(0);
  });
});
