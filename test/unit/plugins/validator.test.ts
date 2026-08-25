/**
 * Tests for src/plugins/validator.ts
 *
 * Covers: plugin validation including post-run-action validation
 */

import { describe, expect, it, spyOn, test } from "bun:test";
import type { AgentAdapter } from "@/agents/types";
import * as loggerModule from "@/logger";
import { validatePlugin } from "@/plugins/validator";
import { makeAgentAdapter } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// validatePlugin with post-run-action
// ─────────────────────────────────────────────────────────────────────────────

describe("validatePlugin with post-run-action", () => {
  it("rejects if postRunAction missing name field", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          // missing name
          description: "Test action",
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction missing description field", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          // missing description
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction.name is not a string", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: 123, // not a string
          description: "Test action",
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction.description is not a string", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: 456, // not a string
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction missing shouldRun function", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          // missing shouldRun
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction.shouldRun is not a function", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          shouldRun: "not a function", // not a function
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction missing execute function", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          shouldRun: async () => true,
          // missing execute
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("rejects if postRunAction.execute is not a function", () => {
    const invalidPlugin = {
      name: "bad-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          shouldRun: async () => true,
          execute: "not a function", // not a function
        },
      },
    };

    const result = validatePlugin(invalidPlugin);
    expect(result).toBeNull();
  });

  it("validates a correct post-run-action plugin", () => {
    const validPlugin = {
      name: "good-pra-plugin",
      version: "1.0.0",
      provides: ["post-run-action"],
      extensions: {
        postRunAction: {
          name: "test-action",
          description: "Test action",
          shouldRun: async () => true,
          execute: async () => ({ success: true, message: "ok" }),
        },
      },
    };

    const result = validatePlugin(validPlugin);
    expect(result).not.toBeNull();
  });
});

describe("validateAgent — the AgentAdapter contract (#1702)", () => {
  // makeAgentAdapter() is the canonical AgentAdapter mock. Driving validateAgent with
  // it is the point of these tests: validateAgent used to require run/plan/decompose,
  // which the CLI adapter had and AgentAdapter has not since ACP became the only
  // protocol, so an agent implementing the shipped interface was rejected at load.
  // Pinning against the helper means the check and the interface cannot drift apart
  // again without this failing.
  const pluginWith = (agent: unknown) => ({
    name: "agent-plugin",
    version: "1.0.0",
    provides: ["agent"],
    extensions: { agent },
  });

  test("accepts an agent implementing the real AgentAdapter surface", () => {
    const agent: AgentAdapter = makeAgentAdapter();
    expect(validatePlugin(pluginWith(agent))).not.toBeNull();
  });

  test("rejects an agent missing a method the manager actually calls", () => {
    const { sendTurn: _dropped, ...withoutSendTurn } = makeAgentAdapter();
    expect(validatePlugin(pluginWith(withoutSendTurn))).toBeNull();
  });

  test.each([
    ["not an object", "not-an-object"],
    ["null", null],
  ])("rejects when the agent extension is %s", (_label, agent) => {
    expect(validatePlugin(pluginWith(agent))).toBeNull();
  });

  test("names the pre-ACP shape once instead of failing field-by-field", () => {
    // Without this, an outdated adapter reports "agent.complete must be a function",
    // which reads as a typo rather than an interface that moved (#1702).
    const logger = loggerModule.getSafeLogger();
    if (!logger) throw new Error("expected getSafeLogger() to return a logger");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // A pre-ACP adapter: the canonical mock with the session primitives stripped
      // and the removed CLI-era methods put back.
      const {
        complete: _complete,
        openSession: _openSession,
        sendTurn: _sendTurn,
        closeSession: _closeSession,
        ...base
      } = makeAgentAdapter();
      const legacyAgent = {
        ...base,
        run: async () => ({}),
        plan: async () => ({}),
        decompose: async () => ({}),
      };

      expect(validatePlugin(pluginWith(legacyAgent))).toBeNull();

      const messages = warn.mock.calls.map((c) => String(c[1]));
      expect(messages.some((m) => m.includes("pre-ACP adapter shape (run, plan, decompose)"))).toBe(true);
      expect(messages.some((m) => m.includes("docs/architecture/agent-adapters.md"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    ["capabilities", "not-an-object"],
    ["capabilities", null],
    ["name", 123],
    ["isInstalled", "not-a-function"],
  ])("rejects when agent.%s has the wrong type", (field, value) => {
    const agent: Record<string, unknown> = { ...makeAgentAdapter() };
    agent[field] = value;
    expect(validatePlugin(pluginWith(agent))).toBeNull();
  });
});
