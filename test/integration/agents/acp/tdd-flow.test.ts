/**
 * Integration tests: TDD three-session flow with AcpAgentAdapter (ACP-007)
 *
 * Verifies:
 * - test-writer → implementer → verifier flow via AcpAgentAdapter
 * - Each TDD session creates its own independent ACP session (3 total)
 * - Cost tracking accumulates correctly from cumulative_token_usage
 * - Isolation checks work correctly after ACP sessions
 * - Auto-commit is called after each session
 * - Rectification gate works with AcpAgentAdapter
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import type { AcpClient, AcpSession, AcpSessionResponse } from "../../../../src/agents/acp/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { NaxConfig } from "../../../../src/config";
import type { UserStory } from "../../../../src/prd";
import { runFullSuiteGate } from "../../../../src/tdd/rectification-gate";
import { runTddSession } from "../../../../src/tdd/session-runner";
import { _gitDeps } from "../../../../src/utils/git";

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
// Git spawn mock — intercepts all git commands needed by runTddSession
// ─────────────────────────────────────────────────────────────────────────────

let originalSpawn: typeof Bun.spawn;
let originalCreateClient: typeof _acpAdapterDeps.createClient;
let originalSleep: typeof _acpAdapterDeps.sleep;
let originalGitSpawn: typeof _gitDeps.spawn;

function mockGitSpawn(diffFileSequences: string[][] = []) {
  let revParseCount = 0;
  let diffCount = 0;

  // @ts-ignore — mocking global for test isolation
  Bun.spawn = mock((cmd: string[], spawnOpts?: unknown) => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      revParseCount++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(`ref-${revParseCount}\n`).body,
        stderr: new Response("").body,
      };
    }
    if (cmd[0] === "git" && cmd[1] === "diff") {
      const files = diffFileSequences[diffCount] ?? [];
      diffCount++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(files.join("\n") + "\n").body,
        stderr: new Response("").body,
      };
    }
    if (cmd[0] === "git" && cmd[1] === "status") {
      return {
        exited: Promise.resolve(0),
        stdout: new Response("nothing to commit\n").body,
        stderr: new Response("").body,
      };
    }
    if (cmd[0] === "git" && (cmd[1] === "commit" || cmd[1] === "add" || cmd[1] === "reset" || cmd[1] === "clean")) {
      return {
        exited: Promise.resolve(0),
        stdout: new Response("").body,
        stderr: new Response("").body,
      };
    }
    // Shell commands (e.g., test runner in rectification gate)
    if (
      (cmd[0] === "/bin/sh" || cmd[0] === "/bin/bash" || cmd[0] === "/bin/zsh") &&
      cmd[1] === "-c"
    ) {
      return {
        pid: 9999,
        exited: Promise.resolve(0),
        stdout: new Response("1 pass, 0 fail\n").body,
        stderr: new Response("").body,
      };
    }
    return originalSpawn(cmd, spawnOpts as Parameters<typeof Bun.spawn>[1]);
  });
}

beforeEach(() => {
  originalSpawn = Bun.spawn;
  originalCreateClient = _acpAdapterDeps.createClient;
  originalSleep = _acpAdapterDeps.sleep;
  originalGitSpawn = _gitDeps.spawn;
  // Disable sleep delays in tests
  _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
});

afterEach(() => {
  Bun.spawn = originalSpawn;
  _acpAdapterDeps.createClient = originalCreateClient;
  _acpAdapterDeps.sleep = originalSleep;
  _gitDeps.spawn = originalGitSpawn;
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
      ["test/feature.test.ts"], // isolation check (test-writer: only test files — OK)
      ["test/feature.test.ts"], // getChangedFiles
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "test-writer",
      adapter,
      story,
      config,
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      true, // lite mode — skip isolation
    );

    expect(result.success).toBe(true);
    expect(result.role).toBe("test-writer");
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  test("implementer session completes successfully via AcpAgentAdapter", async () => {
    const session = makeSession(
      makeResponse({ stopReason: "end_turn", cumulative_token_usage: { input_tokens: 2000, output_tokens: 800 } }),
    );
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
      ["src/feature.ts"], // isolation check (implementer: only src files — OK)
      ["src/feature.ts"], // getChangedFiles
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "implementer",
      adapter,
      story,
      config,
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      true, // lite mode — skip isolation
    );

    expect(result.success).toBe(true);
    expect(result.role).toBe("implementer");
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  test("verifier session completes successfully via AcpAgentAdapter", async () => {
    const session = makeSession(
      makeResponse({ stopReason: "end_turn", cumulative_token_usage: { input_tokens: 1500, output_tokens: 600 } }),
    );
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
      ["src/feature.ts"], // getChangedFiles (no isolation for verifier)
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "verifier",
      adapter,
      story,
      config,
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      true, // lite mode — skip isolation
    );

    expect(result.success).toBe(true);
    expect(result.role).toBe("verifier");
    expect(result.estimatedCost).toBeGreaterThan(0);
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
      "/tmp/nax-acp-test",
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
      await runTddSession(role, adapter, story, config, "/tmp/nax-acp-test", "balanced", "HEAD", undefined, true);
    }

    // 3 sessions total — one per TDD role
    expect(clients).toHaveLength(3);
    for (const c of clients) {
      expect(c.startCalled).toBe(1);
      expect(c.sessionsCalled).toBe(1);
      expect(c.closeCalled).toBe(1);
    }
  });

  test("sessions are independent — one session failing does not affect others", async () => {
    const responses = [
      makeResponse({ stopReason: "end_turn" }), // test-writer: success
      makeResponse({ stopReason: "error" }), // implementer: failure
      makeResponse({ stopReason: "end_turn" }), // verifier: success
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
      "/tmp/nax-acp-test",
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
      "/tmp/nax-acp-test",
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
      "/tmp/nax-acp-test",
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
    // claude-sonnet-4-5: $3/1M input, $15/1M output
    // Session 1: 1000 input + 500 output → 0.003 + 0.0075 = 0.0105
    // Session 2: 2000 input + 800 output → 0.006 + 0.012 = 0.018
    // Session 3: 1500 input + 600 output → 0.0045 + 0.009 = 0.0135

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
        "/tmp/nax-acp-test",
        "balanced",
        "HEAD",
        undefined,
        true,
      );
      costs.push(result.estimatedCost);
    }

    // All 3 sessions should report non-zero costs
    expect(costs[0]).toBeGreaterThan(0);
    expect(costs[1]).toBeGreaterThan(0);
    expect(costs[2]).toBeGreaterThan(0);

    // Session with more tokens should cost more
    expect(costs[1]).toBeGreaterThan(costs[0]);

    // Total across all 3 sessions
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
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      true,
    );

    expect(result.estimatedCost).toBe(0);
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
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      true,
    );

    expect(result.estimatedCost).toBe(0);
  });
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
      ["test/feature.test.ts", "test/helper.test.ts"], // isolation: only test files — pass
      ["test/feature.test.ts", "test/helper.test.ts"], // getChangedFiles
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "test-writer",
      adapter,
      story,
      config,
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      false, // isolation enabled
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
      ["src/feature.ts", "test/feature.test.ts"], // isolation: src file modified — VIOLATION
      ["src/feature.ts", "test/feature.test.ts"], // getChangedFiles
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "test-writer",
      adapter,
      story,
      config,
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      false, // isolation enabled
    );

    expect(result.isolation).toBeDefined();
    expect(result.isolation!.passed).toBe(false);
    expect(result.success).toBe(false); // isolation failure → session failure
  });

  test("implementer isolation passes when only source files are modified", async () => {
    const session = makeSession(makeResponse({ stopReason: "end_turn" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    mockGitSpawn([
      ["src/feature.ts", "src/utils.ts"], // isolation: only src files — pass
      ["src/feature.ts", "src/utils.ts"], // getChangedFiles
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "implementer",
      adapter,
      story,
      config,
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      false, // isolation enabled
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
      ["src/feature.ts"], // isolation: src-only changes — pass for implementer check
      ["src/feature.ts"], // getChangedFiles
    ]);

    const adapter = new AcpAgentAdapter("claude");
    const result = await runTddSession(
      "verifier",
      adapter,
      story,
      config,
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      false, // isolation enabled
    );

    // verifier runs verifyImplementerIsolation (same as implementer)
    expect(result.isolation).toBeDefined();
    expect(result.isolation!.passed).toBe(true);
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: Auto-commit after each session still works
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-commit behavior after ACP sessions", () => {
  test("autoCommitIfDirty is invoked after each session via _gitDeps.spawn", async () => {
    const session = makeSession(makeResponse({ stopReason: "end_turn" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    // Track git calls through _gitDeps.spawn (used by autoCommitIfDirty)
    const gitDepsCalls: string[][] = [];
    const workdir = "/tmp/nax-acp-test";
    // @ts-ignore — mocking _gitDeps.spawn for test isolation
    _gitDeps.spawn = mock((cmd: string[], spawnOpts?: unknown) => {
      gitDepsCalls.push(cmd);
      // autoCommitIfDirty first calls rev-parse --show-toplevel to guard against
      // committing parent-repo files. Return the workdir so the guard passes.
      const isShowToplevel = cmd[1] === "rev-parse" && cmd.includes("--show-toplevel");
      return {
        exited: Promise.resolve(0),
        stdout: new Response(isShowToplevel ? workdir + "\n" : "").body, // empty = clean working tree
        stderr: new Response("").body,
      };
    });

    mockGitSpawn([
      ["test/feature.test.ts"], // isolation diff
      ["test/feature.test.ts"], // getChangedFiles
    ]);

    const adapter = new AcpAgentAdapter("claude");
    await runTddSession(
      "test-writer",
      adapter,
      story,
      config,
      "/tmp/nax-acp-test",
      "balanced",
      "HEAD",
      undefined,
      true,
    );

    // autoCommitIfDirty checks git status --porcelain via _gitDeps.spawn
    const statusCalls = gitDepsCalls.filter((cmd) => cmd[0] === "git" && cmd[1] === "status");
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    // Verify --porcelain flag is used (machine-parseable output)
    expect(statusCalls[0]).toContain("--porcelain");
  });
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
    mockGitSpawn([]);

    const result = await runFullSuiteGate(
      story,
      disabledConfig,
      "/tmp/nax-acp-test",
      adapter,
      "balanced",
      undefined,
      true,
      // biome-ignore lint/suspicious/noExplicitAny: test logger mock
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    );

    expect(result).toBe(false);
  });

  test("returns true when full suite passes without regressions", async () => {
    const session = makeSession(makeResponse({ stopReason: "end_turn" }));
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);

    // Shell test command returns success
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: unknown) => {
      if ((cmd[0] === "/bin/sh" || cmd[0] === "/bin/bash") && cmd[1] === "-c") {
        return {
          pid: 9999,
          exited: Promise.resolve(0),
          stdout: new Response("1 pass, 0 fail\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts as Parameters<typeof Bun.spawn>[1]);
    });

    const adapter = new AcpAgentAdapter("claude");
    const result = await runFullSuiteGate(
      story,
      rectificationConfig,
      "/tmp/nax-acp-test",
      adapter,
      "balanced",
      undefined,
      true,
      // biome-ignore lint/suspicious/noExplicitAny: test logger mock
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    );

    expect(result).toBe(true);
  });

  test("calls agent.run() via AcpAgentAdapter during rectification loop", async () => {
    let clientsCreated = 0;
    _acpAdapterDeps.createClient = mock(() => {
      clientsCreated++;
      const session = makeSession(makeResponse({ stopReason: "end_turn" }));
      return makeClient(session);
    });

    let testRunCount = 0;
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: unknown) => {
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("abc123\n").body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "diff") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("src/feature.ts\n").body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "status") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("nothing to commit\n").body,
          stderr: new Response("").body,
        };
      }
      if ((cmd[0] === "/bin/sh" || cmd[0] === "/bin/bash") && cmd[1] === "-c") {
        testRunCount++;
        // First call: fail with regressions → triggers rectification
        // Second call (after rectification): pass
        const failed = testRunCount === 1;
        // Use bun test output format that parseBunTestOutput recognizes
        const failedOutput = "test/feature.test.ts:\n✘ should work [1.0ms]\n";
        const passedOutput = "test/feature.test.ts:\n✓ should work [1.0ms]\n";
        return {
          pid: 9999,
          exited: Promise.resolve(failed ? 1 : 0),
          stdout: new Response(failed ? failedOutput : passedOutput).body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts as Parameters<typeof Bun.spawn>[1]);
    });

    const adapter = new AcpAgentAdapter("claude");
    const result = await runFullSuiteGate(
      story,
      rectificationConfig,
      "/tmp/nax-acp-test",
      adapter,
      "balanced",
      undefined,
      true,
      // biome-ignore lint/suspicious/noExplicitAny: test logger mock
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    );

    // Rectification agent was invoked via AcpAgentAdapter
    expect(clientsCreated).toBeGreaterThanOrEqual(1);
    expect(result).toBe(true);
  });

  test("rectification gate returns false after max retries with persistent failures", async () => {
    _acpAdapterDeps.createClient = mock(() => {
      const session = makeSession(makeResponse({ stopReason: "end_turn" }));
      return makeClient(session);
    });

    let testRunCount = 0;
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: unknown) => {
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("abc123\n").body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && (cmd[1] === "diff" || cmd[1] === "status")) {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("src/feature.ts\n").body,
          stderr: new Response("").body,
        };
      }
      if ((cmd[0] === "/bin/sh" || cmd[0] === "/bin/bash") && cmd[1] === "-c") {
        testRunCount++;
        // Always fail — exhausts all retries
        // Use bun test output format that parseBunTestOutput recognizes
        return {
          pid: 9999,
          exited: Promise.resolve(1),
          stdout: new Response("test/feature.test.ts:\n✘ should work [1.0ms]\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts as Parameters<typeof Bun.spawn>[1]);
    });

    const adapter = new AcpAgentAdapter("claude");
    const result = await runFullSuiteGate(
      story,
      rectificationConfig,
      "/tmp/nax-acp-test",
      adapter,
      "balanced",
      undefined,
      true,
      // biome-ignore lint/suspicious/noExplicitAny: test logger mock
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    );

    expect(result).toBe(false);
  });
});
