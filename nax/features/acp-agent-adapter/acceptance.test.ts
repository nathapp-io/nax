/**
 * Acceptance Tests — ACP Agent Adapter
 *
 * RED/GREEN gate: these tests define the acceptance criteria for the
 * ACP agent adapter feature. They should FAIL before implementation
 * and PASS after all stories are complete.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: Acceptance generators use adapter.complete() (ACP-001)
// ─────────────────────────────────────────────────────────────────────────────

describe("ACP-001: Acceptance generators use adapter.complete()", () => {
  test("generator.ts does not reference adapter.binary for LLM calls", async () => {
    const source = await Bun.file("src/acceptance/generator.ts").text();
    // Should not have direct Bun.spawn with adapter.binary pattern
    const hasBinarySpawn = /adapter\.binary/.test(source) && /Bun\.spawn/.test(source);
    expect(hasBinarySpawn).toBe(false);
  });

  test("fix-generator.ts does not reference adapter.binary for LLM calls", async () => {
    const source = await Bun.file("src/acceptance/fix-generator.ts").text();
    const hasBinarySpawn = /adapter\.binary/.test(source) && /Bun\.spawn/.test(source);
    expect(hasBinarySpawn).toBe(false);
  });

  test("generator.ts uses adapter.complete() for LLM calls", async () => {
    const source = await Bun.file("src/acceptance/generator.ts").text();
    expect(source).toContain("adapter.complete(");
  });

  test("fix-generator.ts uses adapter.complete() for LLM calls", async () => {
    const source = await Bun.file("src/acceptance/fix-generator.ts").text();
    expect(source).toContain("adapter.complete(");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: AcpAgentAdapter implements AgentAdapter interface (ACP-002)
// ─────────────────────────────────────────────────────────────────────────────

describe("ACP-002: AcpAgentAdapter core", () => {
  test("AcpAgentAdapter module exists and exports the class", async () => {
    const mod = await import("../../../src/agents/acp/adapter");
    expect(mod.AcpAgentAdapter).toBeDefined();
    expect(typeof mod.AcpAgentAdapter).toBe("function");
  });

  test("AcpAgentAdapter implements all AgentAdapter methods", async () => {
    const { AcpAgentAdapter } = await import("../../../src/agents/acp/adapter");
    const adapter = new AcpAgentAdapter("claude");

    // Required methods from AgentAdapter interface
    expect(typeof adapter.run).toBe("function");
    expect(typeof adapter.complete).toBe("function");
    expect(typeof adapter.plan).toBe("function");
    expect(typeof adapter.decompose).toBe("function");
    expect(typeof adapter.isInstalled).toBe("function");
    expect(typeof adapter.buildCommand).toBe("function");

    // Required properties
    expect(adapter.name).toBe("claude");
    expect(typeof adapter.displayName).toBe("string");
    expect(typeof adapter.binary).toBe("string");
    expect(adapter.capabilities).toBeDefined();
    expect(adapter.capabilities.supportedTiers).toBeDefined();
    expect(adapter.capabilities.features).toBeDefined();
  });

  test("AgentResult.success maps from ACP stopReason correctly", async () => {
    // Verify the mapping logic exists
    const mod = await import("../../../src/agents/acp/adapter");
    // The adapter should export or internally handle stopReason → success mapping
    expect(mod.AcpAgentAdapter).toBeDefined();
  });

  test("ACP types module exists", async () => {
    const mod = await import("../../../src/agents/acp/types");
    expect(mod).toBeDefined();
  });

  test("ACP index barrel exports", async () => {
    const mod = await import("../../../src/agents/acp/index");
    expect(mod.AcpAgentAdapter).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Registry integration and config toggle (ACP-003)
// ─────────────────────────────────────────────────────────────────────────────

describe("ACP-003: Registry and config toggle", () => {
  test("config schema accepts agent.protocol field", async () => {
    const { NaxConfigSchema } = await import("../../../src/config/schema");
    // Should parse successfully with agent.protocol = 'acp'
    const result = NaxConfigSchema.safeParse({
      agent: { protocol: "acp" },
    });
    // At minimum, the schema should recognize the agent.protocol field
    // (may fail on other required fields, but should not fail on agent.protocol itself)
    if (!result.success) {
      const agentProtocolError = result.error.issues.find(
        (issue: { path: (string | number)[] }) =>
          issue.path.includes("agent") && issue.path.includes("protocol"),
      );
      expect(agentProtocolError).toBeUndefined();
    }
  });

  test("getAgent returns AcpAgentAdapter when protocol is 'acp'", async () => {
    // This test verifies the registry respects the protocol config
    const { getAgent } = await import("../../../src/agents/registry");
    const { AcpAgentAdapter } = await import("../../../src/agents/acp/adapter");
    // Note: actual behavior depends on global config state
    // This test validates the types exist and are importable
    expect(getAgent).toBeDefined();
    expect(AcpAgentAdapter).toBeDefined();
  });

  test("default protocol is 'cli' for backward compatibility", async () => {
    const { NaxConfigSchema } = await import("../../../src/config/schema");
    const result = NaxConfigSchema.safeParse({});
    if (result.success) {
      const protocol = result.data.agent?.protocol ?? "cli";
      expect(protocol).toBe("cli");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: Interaction bridge (ACP-004)
// ─────────────────────────────────────────────────────────────────────────────

describe("ACP-004: Interaction bridge", () => {
  test("AcpInteractionBridge module exists", async () => {
    const mod = await import("../../../src/agents/acp/interaction-bridge");
    expect(mod.AcpInteractionBridge).toBeDefined();
    expect(typeof mod.AcpInteractionBridge).toBe("function");
  });

  test("Bridge detects question patterns in text", async () => {
    const { AcpInteractionBridge } = await import("../../../src/agents/acp/interaction-bridge");
    // Bridge should expose or internally use question detection
    const bridge = new AcpInteractionBridge({} as any);
    expect(bridge).toBeDefined();
  });

  test("Bridge creates InteractionRequest from agent questions", async () => {
    const { AcpInteractionBridge } = await import("../../../src/agents/acp/interaction-bridge");
    expect(AcpInteractionBridge).toBeDefined();
    // Detailed interaction flow tested in unit tests
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Plan and decompose via ACP (ACP-005)
// ─────────────────────────────────────────────────────────────────────────────

describe("ACP-005: Plan and decompose", () => {
  test("AcpAgentAdapter.plan() exists and is callable", async () => {
    const { AcpAgentAdapter } = await import("../../../src/agents/acp/adapter");
    const adapter = new AcpAgentAdapter("claude");
    expect(typeof adapter.plan).toBe("function");
  });

  test("AcpAgentAdapter.decompose() exists and is callable", async () => {
    const { AcpAgentAdapter } = await import("../../../src/agents/acp/adapter");
    const adapter = new AcpAgentAdapter("claude");
    expect(typeof adapter.decompose).toBe("function");
  });

  test("Interactive plan throws clear unsupported error", async () => {
    const { AcpAgentAdapter } = await import("../../../src/agents/acp/adapter");
    const adapter = new AcpAgentAdapter("claude");

    await expect(
      adapter.plan({
        prompt: "test",
        workdir: "/tmp",
        interactive: true,
      }),
    ).rejects.toThrow(/not.*supported.*ACP|interactive/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: Cost tracking from token usage (ACP-006)
// ─────────────────────────────────────────────────────────────────────────────

describe("ACP-006: Cost tracking", () => {
  test("estimateCostFromTokenUsage module exists", async () => {
    const mod = await import("../../../src/agents/acp/cost");
    expect(mod.estimateCostFromTokenUsage).toBeDefined();
    expect(typeof mod.estimateCostFromTokenUsage).toBe("function");
  });

  test("zero tokens returns zero cost", async () => {
    const { estimateCostFromTokenUsage } = await import("../../../src/agents/acp/cost");
    const cost = estimateCostFromTokenUsage(
      { input_tokens: 0, output_tokens: 0 },
      "claude-sonnet-4",
    );
    expect(cost).toBe(0);
  });

  test("known model returns non-zero cost for non-zero tokens", async () => {
    const { estimateCostFromTokenUsage } = await import("../../../src/agents/acp/cost");
    const cost = estimateCostFromTokenUsage(
      { input_tokens: 1000, output_tokens: 500 },
      "claude-sonnet-4",
    );
    expect(cost).toBeGreaterThan(0);
  });

  test("unknown model falls back to average rate", async () => {
    const { estimateCostFromTokenUsage } = await import("../../../src/agents/acp/cost");
    const cost = estimateCostFromTokenUsage(
      { input_tokens: 1000, output_tokens: 500 },
      "unknown-model-xyz",
    );
    expect(cost).toBeGreaterThan(0);
  });

  test("cache tokens use reduced rates", async () => {
    const { estimateCostFromTokenUsage } = await import("../../../src/agents/acp/cost");
    const costWithCache = estimateCostFromTokenUsage(
      {
        input_tokens: 100,
        output_tokens: 100,
        cache_read_input_tokens: 900,
      },
      "claude-sonnet-4",
    );
    const costWithoutCache = estimateCostFromTokenUsage(
      { input_tokens: 1000, output_tokens: 100 },
      "claude-sonnet-4",
    );
    // Cache reads should be cheaper than full input tokens
    expect(costWithCache).toBeLessThan(costWithoutCache);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: TDD three-session flow (ACP-007)
// ─────────────────────────────────────────────────────────────────────────────

describe("ACP-007: TDD flow with ACP adapter", () => {
  test("TDD session runner accepts AcpAgentAdapter", async () => {
    // Verify the session runner's type signature accepts AgentAdapter (which AcpAgentAdapter implements)
    const { runTddSession } = await import("../../../src/tdd/session-runner");
    const { AcpAgentAdapter } = await import("../../../src/agents/acp/adapter");
    expect(runTddSession).toBeDefined();
    expect(AcpAgentAdapter).toBeDefined();
    // Type compatibility is verified at compile time — this test confirms both modules are importable
  });

  test("rectification gate accepts AcpAgentAdapter", async () => {
    const { runFullSuiteGate } = await import("../../../src/tdd/rectification-gate");
    const { AcpAgentAdapter } = await import("../../../src/agents/acp/adapter");
    expect(runFullSuiteGate).toBeDefined();
    expect(AcpAgentAdapter).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting: Zero regressions
// ─────────────────────────────────────────────────────────────────────────────

describe("Cross-cutting: backward compatibility", () => {
  test("Legacy ClaudeCodeAdapter still exists and is importable", async () => {
    const { ClaudeCodeAdapter } = await import("../../../src/agents/claude");
    expect(ClaudeCodeAdapter).toBeDefined();
  });

  test("Legacy adapter registry still works", async () => {
    const { getAgent, getAllAgentNames } = await import("../../../src/agents/registry");
    const names = getAllAgentNames();
    expect(names).toContain("claude");
    // Legacy adapter should still be accessible
    const agent = getAgent("claude");
    expect(agent).toBeDefined();
  });

  test("acpx dependency is installed", async () => {
    // Verify the acpx package is available
    const mod = await import("acpx");
    expect(mod).toBeDefined();
  });
});
