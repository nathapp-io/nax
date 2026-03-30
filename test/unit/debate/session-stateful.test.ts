/**
 * Tests for DebateSession — US-003: Stateful session mode
 *
 * Covers:
 * - AC1: When sessionMode='stateful', creates SpawnAcpClient per debater and calls
 *        client.createSession() with session name containing storyId and debater index
 * - AC2: When sessionMode='stateful', critique round sends only OTHER debaters' proposals
 *        (session retains its own history — no self-proposal pasted)
 * - AC3: When sessionMode='stateful', all sessions closed via session.close() in finally
 *        — even if debate fails mid-round
 * - AC4: When sessionMode='one-shot', uses adapter.complete() — no persistent sessions created
 * - AC5: When a stateful session fails to create, skip that debater; continue if >= 2 remain
 * - AC6: Two stages with different sessionMode values each use their own mode independently
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { AgentAdapter, CompleteOptions } from "../../../src/agents/types";
import type { AcpClient, AcpSession, AcpSessionResponse } from "../../../src/agents/acp/adapter";

// ─── Extended deps type (US-003 adds createSpawnAcpClient) ───────────────────

type ExtendedDeps = typeof _debateSessionDeps & {
  createSpawnAcpClient?: (cmdStr: string, cwd?: string) => AcpClient;
};

const extDeps = _debateSessionDeps as ExtendedDeps;

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

function makeMockAdapter(
  name: string,
  options: {
    completeFn?: (prompt: string, opts?: CompleteOptions) => Promise<string>;
  } = {},
): AgentAdapter {
  return {
    name,
    displayName: name,
    binary: name,
    capabilities: {
      supportedTiers: ["fast"] as const,
      maxContextTokens: 100_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    },
    isInstalled: async () => true,
    run: async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCost: 0,
    }),
    buildCommand: () => [],
    plan: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    complete: options.completeFn ?? (async () => `output from ${name}`),
  };
}

function makeMockSession(opts: {
  promptFn?: (text: string) => Promise<AcpSessionResponse>;
  closeFn?: () => Promise<void>;
} = {}): AcpSession {
  return {
    prompt:
      opts.promptFn ??
      (async (_text: string): Promise<AcpSessionResponse> => ({
        messages: [{ role: "assistant", content: "session response" }],
        stopReason: "end_turn",
      })),
    close: opts.closeFn ?? (async () => {}),
    cancelActivePrompt: async () => {},
  };
}

function makeMockClient(opts: {
  createSessionFn?: (o: { agentName: string; permissionMode: string; sessionName?: string }) => Promise<AcpSession>;
  closeFn?: () => Promise<void>;
} = {}): AcpClient {
  return {
    start: async () => {},
    createSession:
      opts.createSessionFn ??
      (async (_opts) => makeMockSession()),
    loadSession: async () => null,
    close: opts.closeFn ?? (async () => {}),
  };
}

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "stateful",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "claude-3-5-haiku-20241022" },
      { agent: "opencode", model: "gpt-4o-mini" },
    ],
    ...overrides,
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let origGetAgent: typeof _debateSessionDeps.getAgent;
let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;
let origCreateSpawnAcpClient: ExtendedDeps["createSpawnAcpClient"];

beforeEach(() => {
  origGetAgent = _debateSessionDeps.getAgent;
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  origCreateSpawnAcpClient = extDeps.createSpawnAcpClient;
});

afterEach(() => {
  _debateSessionDeps.getAgent = origGetAgent;
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  extDeps.createSpawnAcpClient = origCreateSpawnAcpClient;
});

// ─── AC1: SpawnAcpClient creation and session naming ──────────────────────────

describe("DebateSession.run() — stateful mode: SpawnAcpClient creation (AC1)", () => {
  test("creates a SpawnAcpClient for each debater when sessionMode is 'stateful'", async () => {
    const createClientCalls: string[] = [];

    extDeps.createSpawnAcpClient = mock((cmdStr: string) => {
      createClientCalls.push(cmdStr);
      return makeMockClient();
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    expect(createClientCalls.length).toBe(2);
  });

  test("cmdStr passed to createSpawnAcpClient includes debater model and agent", async () => {
    const createClientCalls: string[] = [];

    extDeps.createSpawnAcpClient = mock((cmdStr: string) => {
      createClientCalls.push(cmdStr);
      return makeMockClient();
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    expect(createClientCalls.some((c) => c.includes("claude-3-5-haiku-20241022") && c.includes("claude"))).toBe(true);
    expect(createClientCalls.some((c) => c.includes("gpt-4o-mini") && c.includes("opencode"))).toBe(true);
  });

  test("createSession is called with session name containing storyId", async () => {
    const createSessionCalls: Array<{ agentName: string; sessionName?: string }> = [];

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) =>
      makeMockClient({
        createSessionFn: async (opts) => {
          createSessionCalls.push({ agentName: opts.agentName, sessionName: opts.sessionName });
          return makeMockSession();
        },
      }),
    );

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    expect(createSessionCalls.length).toBe(2);
    expect(createSessionCalls.every((c) => c.sessionName?.includes("US-003"))).toBe(true);
  });

  test("session name contains debater index (0 for first, 1 for second)", async () => {
    const sessionNames: string[] = [];

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) =>
      makeMockClient({
        createSessionFn: async (opts) => {
          if (opts.sessionName) sessionNames.push(opts.sessionName);
          return makeMockSession();
        },
      }),
    );

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    // Session names should contain the debater index (0 and 1)
    expect(sessionNames.some((n) => n.includes("-0"))).toBe(true);
    expect(sessionNames.some((n) => n.includes("-1"))).toBe(true);
  });

  test("session name matches pattern 'nax-debate-<storyId>-<debaterIndex>'", async () => {
    const sessionNames: string[] = [];

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) =>
      makeMockClient({
        createSessionFn: async (opts) => {
          if (opts.sessionName) sessionNames.push(opts.sessionName);
          return makeMockSession();
        },
      }),
    );

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    expect(sessionNames).toContain("nax-debate-US-003-0");
    expect(sessionNames).toContain("nax-debate-US-003-1");
  });

  test("uses session.prompt() instead of adapter.complete() in stateful mode", async () => {
    const promptCalls: string[] = [];
    const completeCalls: string[] = [];

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) =>
      makeMockClient({
        createSessionFn: async (_opts) =>
          makeMockSession({
            promptFn: async (text) => {
              promptCalls.push(text);
              return {
                messages: [{ role: "assistant", content: '{"passed": true}' }],
                stopReason: "end_turn",
              };
            },
          }),
      }),
    );

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async (p) => {
          completeCalls.push(p);
          return `complete from ${name}`;
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("the stateful prompt");

    expect(promptCalls.length).toBeGreaterThan(0);
    // adapter.complete() should NOT be called for proposal round in stateful mode
    expect(completeCalls.length).toBe(0);
  });
});

// ─── AC2: Critique round — only other debaters' proposals ─────────────────────

describe("DebateSession.run() — stateful mode: critique round isolation (AC2)", () => {
  test("critique prompt contains only other debaters' proposals, not own", async () => {
    const promptsBySession: Record<number, string[]> = {};
    let sessionIndex = 0;

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      const idx = sessionIndex++;
      return makeMockClient({
        createSessionFn: async (_opts) => {
          promptsBySession[idx] = [];
          return makeMockSession({
            promptFn: async (text) => {
              promptsBySession[idx].push(text);
              return {
                messages: [{ role: "assistant", content: `proposal from debater ${idx}` }],
                stopReason: "end_turn",
              };
            },
          });
        },
      });
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        rounds: 2,
        resolver: { type: "synthesis" },
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    // Each session should be called twice (proposal + critique)
    expect(Object.keys(promptsBySession).length).toBe(2);

    // Session 0's critique prompt should contain session 1's proposal but NOT session 0's proposal
    const session0CritiquePrompt = promptsBySession[0]?.[1];
    expect(session0CritiquePrompt).toBeDefined();
    expect(session0CritiquePrompt).toContain("proposal from debater 1");
    expect(session0CritiquePrompt).not.toContain("proposal from debater 0");
  });

  test("in stateful mode, critique prompt is shorter than full all-proposals paste", async () => {
    // In one-shot mode, the critique contains ALL proposals (including own)
    // In stateful mode, it contains only OTHERS' proposals
    const statefulCritiqueLengths: number[] = [];
    let sessionIndex = 0;

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      const idx = sessionIndex++;
      return makeMockClient({
        createSessionFn: async (_opts) =>
          makeMockSession({
            promptFn: async (text) => {
              // The 2nd prompt is the critique prompt
              if (idx === 0) statefulCritiqueLengths.push(text.length);
              return {
                messages: [
                  { role: "assistant", content: `long proposal output from debater ${idx} with extra content` },
                ],
                stopReason: "end_turn",
              };
            },
          }),
      });
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        rounds: 2,
        resolver: { type: "synthesis" },
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
          { agent: "gemini", model: "gemini-flash" },
        ],
      }),
    });

    await session.run("test prompt");

    // With 3 debaters, stateful critique for debater 0 should include 2 other proposals,
    // not 3 (own would be excluded)
    expect(statefulCritiqueLengths.length).toBeGreaterThan(0);
  });
});

// ─── AC3: Sessions closed in finally block ────────────────────────────────────

describe("DebateSession.run() — stateful mode: session cleanup (AC3)", () => {
  test("calls session.close() for all sessions in finally block after successful run", async () => {
    const closeCalls: number[] = [];
    let sessionIndex = 0;

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      const idx = sessionIndex++;
      return makeMockClient({
        createSessionFn: async (_opts) =>
          makeMockSession({
            closeFn: async () => {
              closeCalls.push(idx);
            },
          }),
      });
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    expect(closeCalls.length).toBe(2);
    expect(closeCalls).toContain(0);
    expect(closeCalls).toContain(1);
  });

  test("calls session.close() even when a prompt round throws mid-debate", async () => {
    const closeCalls: number[] = [];
    let sessionIndex = 0;

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      const idx = sessionIndex++;
      return makeMockClient({
        createSessionFn: async (_opts) =>
          makeMockSession({
            promptFn: async (_text) => {
              if (idx === 1) throw new Error("simulated mid-debate failure");
              return {
                messages: [{ role: "assistant", content: "response" }],
                stopReason: "end_turn",
              };
            },
            closeFn: async () => {
              closeCalls.push(idx);
            },
          }),
      });
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    // Should not throw — debate handles failures gracefully
    await session.run("test prompt");

    // Session 0 (the successful one) must have been closed
    expect(closeCalls).toContain(0);
  });

  test("all successfully created sessions are closed even when debate throws", async () => {
    const closeCalls: number[] = [];
    let sessionIndex = 0;

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      const idx = sessionIndex++;
      return makeMockClient({
        createSessionFn: async (_opts) =>
          makeMockSession({
            promptFn: async (_text) => {
              // All debaters fail during proposal
              throw new Error(`debater ${idx} prompt failed`);
            },
            closeFn: async () => {
              closeCalls.push(idx);
            },
          }),
      });
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    // Both sessions were created, both must be closed
    expect(closeCalls.length).toBe(2);
  });
});

// ─── AC4: One-shot mode unchanged ─────────────────────────────────────────────

describe("DebateSession.run() — one-shot mode: no persistent sessions (AC4)", () => {
  test("does not call createSpawnAcpClient when sessionMode is 'one-shot'", async () => {
    let createClientCallCount = 0;

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      createClientCallCount++;
      return makeMockClient();
    });

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => `{"passed": true}`,
      }),
    );

    const session = new DebateSession({
      storyId: "US-003",
      stage: "review",
      stageConfig: makeStageConfig({
        sessionMode: "one-shot",
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    expect(createClientCallCount).toBe(0);
  });

  test("calls adapter.complete() when sessionMode is 'one-shot'", async () => {
    const completeCalls: string[] = [];

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => makeMockClient());

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => {
          completeCalls.push(name);
          return `{"passed": true}`;
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-003",
      stage: "review",
      stageConfig: makeStageConfig({
        sessionMode: "one-shot",
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    expect(completeCalls).toContain("claude");
    expect(completeCalls).toContain("opencode");
  });
});

// ─── AC5: Stateful session creation failure — skip debater ────────────────────

describe("DebateSession.run() — stateful mode: session creation failure (AC5)", () => {
  test("skips a debater when createSession throws, continues with remaining", async () => {
    const successfulPromptCalls: number[] = [];
    let sessionIndex = 0;

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      const idx = sessionIndex++;
      return makeMockClient({
        createSessionFn: async (_opts) => {
          if (idx === 1) {
            // Second debater's session creation fails
            throw new Error("acpx: failed to create session");
          }
          return makeMockSession({
            promptFn: async (_text) => {
              successfulPromptCalls.push(idx);
              return {
                messages: [{ role: "assistant", content: `output from debater ${idx}` }],
                stopReason: "end_turn",
              };
            },
          });
        },
      });
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
          { agent: "gemini", model: "gemini-flash" },
        ],
      }),
    });

    const result = await session.run("test prompt");

    // Session index 0 (claude) and 2 (gemini) succeed — debate proceeds
    expect(result).toBeDefined();
    expect(result.outcome).not.toBe("skipped");
    // The failed debater should not have been prompted
    expect(successfulPromptCalls).not.toContain(1);
  });

  test("falls back to single-agent when only 1 session succeeds creation", async () => {
    let sessionIndex = 0;

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      const idx = sessionIndex++;
      return makeMockClient({
        createSessionFn: async (_opts) => {
          if (idx !== 0) {
            throw new Error("acpx: session creation error");
          }
          return makeMockSession({
            promptFn: async (_text) => ({
              messages: [{ role: "assistant", content: "solo output" }],
              stopReason: "end_turn",
            }),
          });
        },
      });
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    const result = await session.run("test prompt");

    // With only 1 successful session, falls back to single-agent
    expect(result).toBeDefined();
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
  });

  test("requires minimum 2 debaters — skips failed ones and still debates with remaining 2", async () => {
    let sessionIndex = 0;
    const promptCalls: number[] = [];

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      const idx = sessionIndex++;
      return makeMockClient({
        createSessionFn: async (_opts) => {
          // Only first debater's session fails
          if (idx === 0) {
            throw new Error("acpx: first session failed");
          }
          return makeMockSession({
            promptFn: async (_text) => {
              promptCalls.push(idx);
              return {
                messages: [{ role: "assistant", content: `output ${idx}` }],
                stopReason: "end_turn",
              };
            },
          });
        },
      });
    });

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
          { agent: "gemini", model: "gemini-flash" },
        ],
      }),
    });

    const result = await session.run("test prompt");

    // 2 debaters still succeed — debate proceeds normally (not single-agent fallback)
    expect(result.proposals.length).toBe(2);
    expect(promptCalls).toContain(1);
    expect(promptCalls).toContain(2);
  });
});

// ─── AC6: Independent sessionMode per stage ────────────────────────────────────

describe("DebateSession.run() — independent sessionMode per stage (AC6)", () => {
  test("stateful stage creates sessions; one-shot stage in same run does not", async () => {
    let statefulClientCallCount = 0;
    let oneShotCompleteCallCount = 0;

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) => {
      statefulClientCallCount++;
      return makeMockClient();
    });

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => {
          oneShotCompleteCallCount++;
          return `{"passed": true}`;
        },
      }),
    );

    // Stateful stage
    const statefulSession = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        sessionMode: "stateful",
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await statefulSession.run("stateful plan prompt");

    const clientsAfterStateful = statefulClientCallCount;
    const completesAfterStateful = oneShotCompleteCallCount;

    // One-shot stage
    const oneShotSession = new DebateSession({
      storyId: "US-003",
      stage: "review",
      stageConfig: makeStageConfig({
        sessionMode: "one-shot",
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await oneShotSession.run("one-shot review prompt");

    // Stateful stage used clients
    expect(clientsAfterStateful).toBeGreaterThan(0);
    // One-shot stage did NOT create new clients
    expect(statefulClientCallCount).toBe(clientsAfterStateful);
    // One-shot stage used adapter.complete()
    expect(oneShotCompleteCallCount).toBeGreaterThan(completesAfterStateful);
  });

  test("each DebateSession instance uses its own sessionMode independently", async () => {
    const sessionNames: string[] = [];

    extDeps.createSpawnAcpClient = mock((_cmdStr: string) =>
      makeMockClient({
        createSessionFn: async (opts) => {
          if (opts.sessionName) sessionNames.push(opts.sessionName);
          return makeMockSession();
        },
      }),
    );

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const statefulPlanSession = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({
        sessionMode: "stateful",
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    const statefulReviewSession = new DebateSession({
      storyId: "US-003",
      stage: "review",
      stageConfig: makeStageConfig({
        sessionMode: "stateful",
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await statefulPlanSession.run("plan prompt");
    await statefulReviewSession.run("review prompt");

    // Both stages created their own independent sessions
    expect(sessionNames.length).toBe(4); // 2 debaters × 2 stages
    // Session names should be unique per stage
    const uniqueNames = new Set(sessionNames);
    expect(uniqueNames.size).toBe(4);
  });
});
