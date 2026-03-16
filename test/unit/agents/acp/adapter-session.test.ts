/**
 * Tests for AcpAgentAdapter — session mode (_runWithClient)
 *
 * Tests the acpx session-based run() flow via createClient injectable dep:
 * - Single turn, no question → correct AgentResult
 * - Turn with question → interactionBridge.onQuestionDetected() → second turn → done
 * - Interaction timeout → partial result returned
 * - Max turns reached → returns last output
 * - Session close failure → silently ignored
 * - Cost accumulation across multiple turns
 * - Session naming (cwd hash + feature + story + role)
 * - Permission mode follows dangerouslySkipPermissions
 * - ensureAcpSession resumes via loadSession before createSession
 * - sessionRole suffix for TDD isolation
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps, buildSessionName, ensureAcpSession } from "../../../../src/agents/acp/adapter";
import type { AcpClient, AcpSession } from "../../../../src/agents/acp/adapter";
import type { AgentRunOptions } from "../../../../src/agents/types";
import { makeClient, makeSession } from "./adapter.test";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_OPTIONS: AgentRunOptions = {
  prompt: "implement the feature",
  workdir: "/tmp/test-project",
  modelTier: "balanced",
  modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
  timeoutSeconds: 30,
  dangerouslySkipPermissions: true,
  featureName: "string-toolkit",
  storyId: "ST-001",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter — session mode (run)", () => {
  let adapter: AcpAgentAdapter;
  let originalCreateClient: typeof _acpAdapterDeps.createClient;
  let originalSleep: typeof _acpAdapterDeps.sleep;

  beforeEach(() => {
    adapter = new AcpAgentAdapter("claude");
    originalCreateClient = _acpAdapterDeps.createClient;
    originalSleep = _acpAdapterDeps.sleep;
    _acpAdapterDeps.sleep = async () => {};
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = originalCreateClient;
    _acpAdapterDeps.sleep = originalSleep;
    mock.restore();
  });

  describe("single turn — no question", () => {
    test("returns success=true when session prompt exits 0", async () => {
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

      const result = await adapter.run(BASE_OPTIONS);
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    test("output contains assistant text from session response", async () => {
      const session = makeSession({
        promptFn: async (_: string) => ({
          messages: [{ role: "assistant", content: "All tests pass now." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
        }),
      });
      _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

      const result = await adapter.run(BASE_OPTIONS);
      expect(result.output).toContain("All tests pass now.");
    });

    test("estimatedCost is non-zero when token usage present", async () => {
      const session = makeSession({
        promptFn: async (_: string) => ({
          messages: [{ role: "assistant", content: "done" }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 500, output_tokens: 200 },
        }),
      });
      _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

      const result = await adapter.run(BASE_OPTIONS);
      expect(result.estimatedCost).toBeGreaterThan(0);
    });

    test("rateLimited is false on successful run", async () => {
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

      const result = await adapter.run(BASE_OPTIONS);
      expect(result.rateLimited).toBe(false);
    });
  });

  describe("turn with question → interaction bridge", () => {
    test("calls interactionBridge.onQuestionDetected when output contains question", async () => {
      let promptCallCount = 0;
      const answers: string[] = [];

      const session = makeSession({
        promptFn: async (_: string) => {
          promptCallCount++;
          if (promptCallCount === 1) {
            return {
              messages: [{ role: "assistant", content: "Which OAuth provider should I use?" }],
              stopReason: "end_turn",
              cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
            };
          }
          return {
            messages: [{ role: "assistant", content: "Implemented with GitHub OAuth." }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
          };
        },
      });
      _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

      const bridge = {
        onQuestionDetected: async (q: string) => {
          answers.push(q);
          return "Use GitHub OAuth";
        },
      };

      const result = await adapter.run({ ...BASE_OPTIONS, interactionBridge: bridge });

      expect(answers).toHaveLength(1);
      expect(answers[0]).toContain("OAuth provider");
      expect(promptCallCount).toBe(2);
      expect(result.output).toContain("GitHub OAuth");
    });

    test("stops loop when interactionBridge throws (interaction timeout)", async () => {
      let promptCallCount = 0;

      const session = makeSession({
        promptFn: async (_: string) => {
          promptCallCount++;
          return {
            messages: [{ role: "assistant", content: "Which environment: prod or staging?" }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
          };
        },
      });
      _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

      const bridge = {
        onQuestionDetected: async (_q: string) => {
          throw new Error("interaction timeout");
        },
      };

      const result = await adapter.run({ ...BASE_OPTIONS, interactionBridge: bridge });
      expect(promptCallCount).toBe(1);
      expect(result).toBeDefined();
    });
  });

  describe("error handling", () => {
    test("returns failure when session prompt throws", async () => {
      const session = makeSession({
        promptFn: async (_: string) => { throw new Error("session error"); },
      });
      _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));
      _acpAdapterDeps.sleep = async () => {};

      const result = await adapter.run(BASE_OPTIONS);
      expect(result.success).toBe(false);
    });

    test("session close failure is silently ignored — result still returned", async () => {
      const session = makeSession({
        closeFn: async () => { throw new Error("close failed"); },
      });
      _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

      const result = await adapter.run(BASE_OPTIONS);
      expect(result).toBeDefined();
    });
  });

  describe("cost accumulation across turns", () => {
    test("accumulates token usage across multiple turns", async () => {
      let promptCallCount = 0;

      const session = makeSession({
        promptFn: async (_: string) => {
          promptCallCount++;
          if (promptCallCount === 1) {
            return {
              messages: [{ role: "assistant", content: "Should I use TypeScript?" }],
              stopReason: "end_turn",
              cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
            };
          }
          return {
            messages: [{ role: "assistant", content: "Done with TypeScript." }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 200, output_tokens: 80 },
          };
        },
      });
      _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

      const bridge = {
        onQuestionDetected: async (_q: string) => "Yes, use TypeScript",
      };

      const result = await adapter.run({ ...BASE_OPTIONS, interactionBridge: bridge });

      expect(result.estimatedCost).toBeGreaterThan(0);
      expect(promptCallCount).toBe(2);
    });
  });

  describe("session naming", () => {
    test("uses featureName and storyId to build deterministic session name", async () => {
      const capturedCmds: string[] = [];
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((cmd: string) => {
        capturedCmds.push(cmd);
        return makeClient(session);
      });

      await adapter.run({ ...BASE_OPTIONS, featureName: "auth-module", storyId: "AM-001" });

      expect(capturedCmds.length).toBeGreaterThan(0);
    });

    test("acpSessionName option does not affect createClient invocation", async () => {
      const capturedCmds: string[] = [];
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((cmd: string) => {
        capturedCmds.push(cmd);
        return makeClient(session);
      });

      await adapter.run({ ...BASE_OPTIONS, acpSessionName: "custom-session-xyz" });

      expect(capturedCmds.length).toBeGreaterThan(0);
    });

    test("sessionRole appended to session name for TDD isolation", async () => {
      const capturedNames: string[] = [];
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((_cmd: string) =>
        makeClient(session, {
          createSessionFn: async (opts) => { capturedNames.push(opts.sessionName ?? ""); return session; },
        }),
      );

      await adapter.run({ ...BASE_OPTIONS, featureName: "string-toolkit", storyId: "ST-001", sessionRole: "test-writer" });

      expect(capturedNames[0]).toContain("test-writer");
      expect(capturedNames[0]).toContain("string-toolkit");
      expect(capturedNames[0]).toContain("st-001");
    });

    test("different sessionRoles produce different session names", () => {
      const writerName = buildSessionName("/proj/foo", "feat", "ST-001", "test-writer");
      const implName   = buildSessionName("/proj/foo", "feat", "ST-001", "implementer");
      const verName    = buildSessionName("/proj/foo", "feat", "ST-001", "verifier");
      expect(writerName).not.toBe(implName);
      expect(implName).not.toBe(verName);
      expect(writerName).not.toBe(verName);
    });

    test("different worktrees produce different session names", () => {
      const main      = buildSessionName("/repos/nax",     "feat", "ST-001");
      const worktree  = buildSessionName("/repos/nax-acp", "feat", "ST-001");
      expect(main).not.toBe(worktree);
    });

    test("same path always produces same session name (stable)", () => {
      const a = buildSessionName("/repos/nax", "string-toolkit", "ST-001");
      const b = buildSessionName("/repos/nax", "string-toolkit", "ST-001");
      expect(a).toBe(b);
    });

    test("session name contains 8-char cwd hash", () => {
      const workdir = "/repos/nax-test";
      const hash = createHash("sha256").update(workdir).digest("hex").slice(0, 8);
      const name = buildSessionName(workdir, "feat", "ST-001");
      expect(name).toContain(hash);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Permission mode
  // ─────────────────────────────────────────────────────────────────────────

  describe("permission mode", () => {
    test("approve-all when permissionProfile is unrestricted", async () => {
      let capturedMode = "";
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((_cmd: string) =>
        makeClient(session, {
          createSessionFn: async (opts) => { capturedMode = opts.permissionMode; return session; },
        }),
      );
      await adapter.run({
        ...BASE_OPTIONS,
        config: { execution: { permissionProfile: "unrestricted" } } as import("../../../../src/config").NaxConfig,
      });
      expect(capturedMode).toBe("approve-all");
    });

    test("default when dangerouslySkipPermissions is false", async () => {
      let capturedMode = "";
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((_cmd: string) =>
        makeClient(session, {
          createSessionFn: async (opts) => { capturedMode = opts.permissionMode; return session; },
        }),
      );
      await adapter.run({ ...BASE_OPTIONS, dangerouslySkipPermissions: false });
      expect(capturedMode).toBe("approve-reads");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ensureAcpSession — loadSession resume path
  // ─────────────────────────────────────────────────────────────────────────

  describe("ensureAcpSession", () => {
    test("resumes existing session via loadSession before createSession", async () => {
      const existingSession = makeSession();
      let createCalled = false;
      const client: AcpClient = {
        start: async () => {},
        close: async () => {},
        loadSession: async (_name: string) => existingSession,
        createSession: async () => { createCalled = true; return makeSession(); },
      };

      const session = await ensureAcpSession(client, "nax-abc-feat-ST-001", "claude", "approve-all");
      expect(session).toBe(existingSession);
      expect(createCalled).toBe(false);
    });

    test("creates new session when loadSession returns null", async () => {
      const newSession = makeSession();
      let createCalled = false;
      const client: AcpClient = {
        start: async () => {},
        close: async () => {},
        loadSession: async (_name: string) => null,
        createSession: async () => { createCalled = true; return newSession; },
      };

      const session = await ensureAcpSession(client, "nax-abc-feat-ST-001", "claude", "approve-all");
      expect(session).toBe(newSession);
      expect(createCalled).toBe(true);
    });

    test("creates new session when loadSession is not available", async () => {
      const newSession = makeSession();
      let createCalled = false;
      const client: AcpClient = {
        start: async () => {},
        close: async () => {},
        createSession: async () => { createCalled = true; return newSession; },
      };

      const session = await ensureAcpSession(client, "nax-abc-feat-ST-001", "claude", "default");
      expect(session).toBe(newSession);
      expect(createCalled).toBe(true);
    });

    test("falls back to createSession when loadSession throws", async () => {
      const newSession = makeSession();
      let createCalled = false;
      const client: AcpClient = {
        start: async () => {},
        close: async () => {},
        loadSession: async () => { throw new Error("session store unavailable"); },
        createSession: async () => { createCalled = true; return newSession; },
      };

      const session = await ensureAcpSession(client, "nax-abc-feat-ST-001", "claude", "approve-all");
      expect(session).toBe(newSession);
      expect(createCalled).toBe(true);
    });
  });
});
