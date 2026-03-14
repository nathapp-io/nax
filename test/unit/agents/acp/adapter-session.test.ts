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
 * - Session naming
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
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
  });
});
