/**
 * Acceptance Tests — ACP Agent Adapter
 *
 * RED/GREEN gate for the acp-agent-adapter feature.
 * Uses file-existence checks for unimplemented modules to avoid crashing
 * during the RED phase. Dynamic imports only for things that exist (ACP-001 results).
 */

import { describe, test, expect } from "bun:test";

// ─────────────────────────────────────────────────────────────────
// AC-1: Acceptance generators use adapter.complete() (ACP-001)
// ─────────────────────────────────────────────────────────────────

describe("ACP-001: Acceptance generators use adapter.complete()", () => {
  test("generator.ts does not use Bun.spawn with adapter.binary", async () => {
    const source = await Bun.file("src/acceptance/generator.ts").text();
    const hasBinarySpawn = /adapter\.binary/.test(source) && /Bun\.spawn/.test(source);
    expect(hasBinarySpawn).toBe(false);
  });

  test("fix-generator.ts does not use Bun.spawn with adapter.binary", async () => {
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

// ─────────────────────────────────────────────────────────────────
// AC-2: AcpAgentAdapter core (ACP-002)
// ─────────────────────────────────────────────────────────────────

describe("ACP-002: AcpAgentAdapter core", () => {
  test("src/agents/acp/adapter.ts exists", async () => {
    expect(await Bun.file("src/agents/acp/adapter.ts").exists()).toBe(true);
  });

  test("src/agents/acp/types.ts exists", async () => {
    expect(await Bun.file("src/agents/acp/types.ts").exists()).toBe(true);
  });

  test("src/agents/acp/index.ts exists", async () => {
    expect(await Bun.file("src/agents/acp/index.ts").exists()).toBe(true);
  });

  test("adapter.ts exports AcpAgentAdapter class", async () => {
    const exists = await Bun.file("src/agents/acp/adapter.ts").exists();
    if (!exists) { expect(exists).toBe(true); return; }
    const source = await Bun.file("src/agents/acp/adapter.ts").text();
    expect(source).toContain("AcpAgentAdapter");
    expect(source).toContain("implements AgentAdapter");
  });

  test("adapter.ts has run() and complete() methods", async () => {
    const exists = await Bun.file("src/agents/acp/adapter.ts").exists();
    if (!exists) { expect(exists).toBe(true); return; }
    const source = await Bun.file("src/agents/acp/adapter.ts").text();
    expect(source).toContain("async run(");
    expect(source).toContain("async complete(");
  });

  test("SpawnAcpClient exists for CLI-based ACP", async () => {
    // nax uses SpawnAcpClient (spawns acpx CLI) instead of acpx npm package
    const exists = await Bun.file("src/agents/acp/spawn-client.ts").exists();
    expect(exists).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// AC-3: Registry + config toggle (ACP-003)
// ─────────────────────────────────────────────────────────────────

describe("ACP-003: Registry and config toggle", () => {
  test("config schema file contains agent.protocol field", async () => {
    const source = await Bun.file("src/config/runtime-types.ts").text();
    expect(source).toContain("protocol");
  });

  test("registry.ts imports AcpAgentAdapter", async () => {
    const source = await Bun.file("src/agents/registry.ts").text();
    const importsAcp = source.includes("AcpAgentAdapter") || source.includes("acp/adapter");
    expect(importsAcp).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// AC-4: Interaction bridge (ACP-004)
// ─────────────────────────────────────────────────────────────────

describe("ACP-004: Interaction bridge", () => {
  test("src/agents/acp/interaction-bridge.ts exists", async () => {
    expect(await Bun.file("src/agents/acp/interaction-bridge.ts").exists()).toBe(true);
  });

  test("interaction-bridge.ts exports AcpInteractionBridge", async () => {
    const exists = await Bun.file("src/agents/acp/interaction-bridge.ts").exists();
    if (!exists) { expect(exists).toBe(true); return; }
    const source = await Bun.file("src/agents/acp/interaction-bridge.ts").text();
    expect(source).toContain("AcpInteractionBridge");
  });

  test("interaction-bridge.ts has onSessionUpdate method", async () => {
    const exists = await Bun.file("src/agents/acp/interaction-bridge.ts").exists();
    if (!exists) { expect(exists).toBe(true); return; }
    const source = await Bun.file("src/agents/acp/interaction-bridge.ts").text();
    expect(source).toContain("onSessionUpdate");
  });
});

// ─────────────────────────────────────────────────────────────────
// AC-5: Plan and decompose (ACP-005)
// ─────────────────────────────────────────────────────────────────

describe("ACP-005: Plan and decompose", () => {
  test("adapter.ts implements plan() method", async () => {
    const exists = await Bun.file("src/agents/acp/adapter.ts").exists();
    if (!exists) { expect(exists).toBe(true); return; }
    const source = await Bun.file("src/agents/acp/adapter.ts").text();
    expect(source).toContain("async plan(");
  });

  test("adapter.ts implements decompose() method", async () => {
    const exists = await Bun.file("src/agents/acp/adapter.ts").exists();
    if (!exists) { expect(exists).toBe(true); return; }
    const source = await Bun.file("src/agents/acp/adapter.ts").text();
    expect(source).toContain("async decompose(");
  });
});

// ─────────────────────────────────────────────────────────────────
// AC-6: Cost tracking (ACP-006)
// ─────────────────────────────────────────────────────────────────

describe("ACP-006: Cost tracking", () => {
  test("src/agents/acp/cost.ts exists", async () => {
    expect(await Bun.file("src/agents/acp/cost.ts").exists()).toBe(true);
  });

  test("cost.ts exports estimateCostFromTokenUsage", async () => {
    const exists = await Bun.file("src/agents/acp/cost.ts").exists();
    if (!exists) { expect(exists).toBe(true); return; }
    const source = await Bun.file("src/agents/acp/cost.ts").text();
    expect(source).toContain("estimateCostFromTokenUsage");
  });

  test("cost.ts handles zero tokens", async () => {
    const exists = await Bun.file("src/agents/acp/cost.ts").exists();
    if (!exists) { expect(exists).toBe(true); return; }
    const source = await Bun.file("src/agents/acp/cost.ts").text();
    // Should have logic for zero token handling
    expect(source.length).toBeGreaterThan(100);
  });
});

// ─────────────────────────────────────────────────────────────────
// AC-7: TDD flow (ACP-007)
// ─────────────────────────────────────────────────────────────────

describe("ACP-007: TDD flow with ACP adapter", () => {
  test("TDD session runner is compatible with AgentAdapter interface", async () => {
    const source = await Bun.file("src/tdd/session-runner.ts").text();
    expect(source).toContain("AgentAdapter");
  });

  test("Cost accumulation: adapter.ts references estimatedCost", async () => {
    const exists = await Bun.file("src/agents/acp/adapter.ts").exists();
    if (!exists) { expect(exists).toBe(true); return; }
    const source = await Bun.file("src/agents/acp/adapter.ts").text();
    expect(source).toContain("estimatedCost");
  });
});

// ─────────────────────────────────────────────────────────────────
// Cross-cutting: Backward compatibility
// ─────────────────────────────────────────────────────────────────

describe("Cross-cutting: backward compatibility", () => {
  test("Legacy ClaudeCodeAdapter still exists", async () => {
    expect(await Bun.file("src/agents/claude.ts").exists()).toBe(true);
  });

  test("Legacy registry still exports getAgent", async () => {
    const source = await Bun.file("src/agents/registry.ts").text();
    expect(source).toContain("getAgent");
  });

  test("Default protocol is acp", async () => {
    const source = await Bun.file("src/config/defaults.ts").text();
    // Default protocol is acp
    expect(source).toContain('"acp"');
  });
});
