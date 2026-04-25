/**
 * Tests for AcpAgentAdapter — session mode
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
import { AcpAgentAdapter, _acpAdapterDeps, computeAcpHandle, ensureAcpSession } from "../../../../src/agents/acp/adapter";
import { withDepsRestore } from "../../../helpers/deps";
import type { AcpClient } from "../../../../src/agents/acp/adapter";
import type { AgentRunOptions } from "../../../../src/agents/types";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
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
  config: DEFAULT_CONFIG,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter — session mode (run)", () => {
  let adapter: AcpAgentAdapter;

  withDepsRestore(_acpAdapterDeps, ["createClient", "sleep"]);

  beforeEach(() => {
    adapter = new AcpAgentAdapter("claude", DEFAULT_CONFIG);
    _acpAdapterDeps.sleep = async () => {};
  });

  afterEach(() => {
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

  // Interaction bridge and context pull tool tests extracted to adapter-interaction.test.ts

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
        detectQuestion: async (_t: string) => true,
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

    test("sessionHandle option does not affect createClient invocation", async () => {
      const capturedCmds: string[] = [];
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((cmd: string) => {
        capturedCmds.push(cmd);
        return makeClient(session);
      });

      await adapter.run({ ...BASE_OPTIONS, sessionHandle: "custom-session-xyz" });

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
      const writerName = computeAcpHandle("/proj/foo", "feat", "ST-001", "test-writer");
      const implName   = computeAcpHandle("/proj/foo", "feat", "ST-001", "implementer");
      const verName    = computeAcpHandle("/proj/foo", "feat", "ST-001", "verifier");
      expect(writerName).not.toBe(implName);
      expect(implName).not.toBe(verName);
      expect(writerName).not.toBe(verName);
    });

    test("different worktrees produce different session names", () => {
      const main      = computeAcpHandle("/repos/nax",     "feat", "ST-001");
      const worktree  = computeAcpHandle("/repos/nax-acp", "feat", "ST-001");
      expect(main).not.toBe(worktree);
    });

    test("same path always produces same session name (stable)", () => {
      const a = computeAcpHandle("/repos/nax", "string-toolkit", "ST-001");
      const b = computeAcpHandle("/repos/nax", "string-toolkit", "ST-001");
      expect(a).toBe(b);
    });

    test("session name contains 8-char cwd hash", () => {
      const workdir = "/repos/nax-test";
      const hash = createHash("sha256").update(workdir).digest("hex").slice(0, 8);
      const name = computeAcpHandle(workdir, "feat", "ST-001");
      expect(name).toContain(hash);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Permission mode
  // ─────────────────────────────────────────────────────────────────────────

  describe("permission mode", () => {
    test("approve-all when resolvedPermissions.mode is approve-all", async () => {
      let capturedMode = "";
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((_cmd: string) =>
        makeClient(session, {
          createSessionFn: async (opts) => { capturedMode = opts.permissionMode; return session; },
        }),
      );
      await adapter.run({
        ...BASE_OPTIONS,
        resolvedPermissions: { mode: "approve-all", skipPermissions: true },
      });
      expect(capturedMode).toBe("approve-all");
    });

    test("approve-reads when resolvedPermissions.mode is approve-reads", async () => {
      let capturedMode = "";
      const session = makeSession();
      _acpAdapterDeps.createClient = mock((_cmd: string) =>
        makeClient(session, {
          createSessionFn: async (opts) => { capturedMode = opts.permissionMode; return session; },
        }),
      );
      await adapter.run({
        ...BASE_OPTIONS,
        resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
      });
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

      const { session, resumed } = await ensureAcpSession(client, "nax-abc-feat-ST-001", "claude", "approve-all");
      expect(session).toBe(existingSession);
      expect(resumed).toBe(true);
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

      const { session, resumed } = await ensureAcpSession(client, "nax-abc-feat-ST-001", "claude", "approve-all");
      expect(session).toBe(newSession);
      expect(resumed).toBe(false);
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

      const { session, resumed } = await ensureAcpSession(client, "nax-abc-feat-ST-001", "claude", "default");
      expect(session).toBe(newSession);
      expect(resumed).toBe(false);
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

      const { session, resumed } = await ensureAcpSession(client, "nax-abc-feat-ST-001", "claude", "approve-all");
      expect(session).toBe(newSession);
      expect(resumed).toBe(false);
      expect(createCalled).toBe(true);
    });
  });
});

// Phase 1 plumbing tests (protocolIds, sessionRetries, deriveSessionName) have been
// extracted to adapter-phase1.test.ts to keep this file under the 400-line limit.
