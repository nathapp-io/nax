/**
 * Tests for ACP-003: Registry integration and config toggle
 *
 * Covers:
 * - createAgentRegistry() returns AcpAgentAdapter when config.agent.protocol is 'acp'
 * - createAgentRegistry() returns ClaudeCodeAdapter when config.agent.protocol is 'cli' or unset
 * - AgentConfig type is exported with correct shape from config/schema
 * - Default protocol is 'cli' for backward compatibility
 * - AcpAgentAdapter instances are reused per agent name within a registry
 * - checkAgentHealth() works with both ACP and legacy adapters
 * - logActiveProtocol() logs the active protocol
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { ClaudeCodeAdapter } from "../../../../src/agents/claude";
import { createAgentRegistry } from "../../../../src/agents/registry";
import type { AgentConfig } from "../../../../src/config/schema";
import type { NaxConfig } from "../../../../src/config/schema";
import { DEFAULT_CONFIG } from "../../../../src/config/schema";
import { logActiveProtocol } from "../../../../src/execution/lifecycle/run-initialization";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(agentOverrides?: AgentConfig): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    agent: agentOverrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createAgentRegistry — protocol selection
// ─────────────────────────────────────────────────────────────────────────────

describe("createAgentRegistry — protocol selection", () => {
  const origWhich = _acpAdapterDeps.which;

  beforeEach(() => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
  });

  afterEach(() => {
    _acpAdapterDeps.which = origWhich;
    mock.restore();
  });

  test("returns AcpAgentAdapter for 'claude' when protocol is 'acp'", () => {
    const registry = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const agent = registry.getAgent("claude");
    expect(agent).toBeInstanceOf(AcpAgentAdapter);
  });

  test("AcpAgentAdapter name is 'claude' when requested by name", () => {
    const registry = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const agent = registry.getAgent("claude");
    expect(agent?.name).toBe("claude");
  });

  test("returns ClaudeCodeAdapter for 'claude' when protocol is 'cli'", () => {
    const registry = createAgentRegistry(makeConfig({ protocol: "cli" }));
    const agent = registry.getAgent("claude");
    expect(agent).toBeInstanceOf(ClaudeCodeAdapter);
  });

  test("returns ClaudeCodeAdapter for 'claude' when agent config is unset (default cli)", () => {
    const registry = createAgentRegistry(makeConfig(undefined));
    const agent = registry.getAgent("claude");
    expect(agent).toBeInstanceOf(ClaudeCodeAdapter);
  });

  test("returns undefined for unknown agent name regardless of protocol", () => {
    const registryAcp = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const registryCli = createAgentRegistry(makeConfig({ protocol: "cli" }));
    expect(registryAcp.getAgent("unknown-agent-xyz")).toBeUndefined();
    expect(registryCli.getAgent("unknown-agent-xyz")).toBeUndefined();
  });

  test("exposes protocol field matching the configured protocol", () => {
    const acpRegistry = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const cliRegistry = createAgentRegistry(makeConfig({ protocol: "cli" }));
    const defaultRegistry = createAgentRegistry(makeConfig());
    expect(acpRegistry.protocol).toBe("acp");
    expect(cliRegistry.protocol).toBe("cli");
    expect(defaultRegistry.protocol).toBe("cli");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createAgentRegistry — instance reuse
// ─────────────────────────────────────────────────────────────────────────────

describe("createAgentRegistry — instance reuse", () => {
  test("returns the same AcpAgentAdapter instance on repeated getAgent calls", () => {
    const registry = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const first = registry.getAgent("claude");
    const second = registry.getAgent("claude");
    expect(first).toBe(second);
  });

  test("creates distinct AcpAgentAdapter instances for different agent names", () => {
    const registry = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const claude = registry.getAgent("claude");
    const codex = registry.getAgent("codex");
    // Both should be AcpAgentAdapter instances
    expect(claude).toBeInstanceOf(AcpAgentAdapter);
    expect(codex).toBeInstanceOf(AcpAgentAdapter);
    // But they should be distinct objects
    expect(claude).not.toBe(codex);
  });

  test("separate registry instances do not share AcpAgentAdapter instances", () => {
    const r1 = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const r2 = createAgentRegistry(makeConfig({ protocol: "acp" }));
    expect(r1.getAgent("claude")).not.toBe(r2.getAgent("claude"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config schema — AgentConfig type
// ─────────────────────────────────────────────────────────────────────────────

describe("Config schema — AgentConfig", () => {
  test("NaxConfig accepts agent.protocol: 'acp'", () => {
    const config: NaxConfig = makeConfig({ protocol: "acp" });
    expect(config.agent?.protocol).toBe("acp");
  });

  test("NaxConfig accepts agent.protocol: 'cli'", () => {
    const config: NaxConfig = makeConfig({ protocol: "cli" });
    expect(config.agent?.protocol).toBe("cli");
  });

  test("NaxConfig agent field is optional (backward compatibility)", () => {
    const config: NaxConfig = makeConfig();
    expect(config.agent).toBeUndefined();
  });

  test("AgentConfig accepts acpPermissionMode field", () => {
    const agentConfig: AgentConfig = { protocol: "acp", acpPermissionMode: "approve-all" };
    expect(agentConfig.acpPermissionMode).toBe("approve-all");
  });

  test("DEFAULT_CONFIG does not have agent field (cli is default without explicit config)", () => {
    expect(DEFAULT_CONFIG.agent).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createAgentRegistry — checkAgentHealth
// ─────────────────────────────────────────────────────────────────────────────

describe("createAgentRegistry — checkAgentHealth()", () => {
  const origWhich = _acpAdapterDeps.which;

  afterEach(() => {
    _acpAdapterDeps.which = origWhich;
    mock.restore();
  });

  test("returns health entries for all known agents when protocol is 'acp'", async () => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
    const registry = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const health = await registry.checkAgentHealth();
    expect(Array.isArray(health)).toBe(true);
    expect(health.length).toBeGreaterThan(0);
  });

  test("each health entry has name, displayName, and installed fields", async () => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
    const registry = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const health = await registry.checkAgentHealth();
    for (const entry of health) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.displayName).toBe("string");
      expect(typeof entry.installed).toBe("boolean");
    }
  });

  test("health entry installed is true when binary is on PATH (ACP protocol)", async () => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
    const registry = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const health = await registry.checkAgentHealth();
    const claudeEntry = health.find((e) => e.name === "claude");
    expect(claudeEntry).toBeDefined();
    expect(claudeEntry?.installed).toBe(true);
  });

  test("health entry installed is false when binary is not on PATH (ACP protocol)", async () => {
    _acpAdapterDeps.which = mock((_name: string) => null);
    const registry = createAgentRegistry(makeConfig({ protocol: "acp" }));
    const health = await registry.checkAgentHealth();
    const claudeEntry = health.find((e) => e.name === "claude");
    expect(claudeEntry).toBeDefined();
    expect(claudeEntry?.installed).toBe(false);
  });

  test("returns health entries for all known agents when protocol is 'cli'", async () => {
    const registry = createAgentRegistry(makeConfig({ protocol: "cli" }));
    const health = await registry.checkAgentHealth();
    expect(Array.isArray(health)).toBe(true);
    expect(health.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// logActiveProtocol — run-initialization logging
// ─────────────────────────────────────────────────────────────────────────────

describe("logActiveProtocol()", () => {
  test("does not throw when protocol is 'acp'", () => {
    expect(() => logActiveProtocol(makeConfig({ protocol: "acp" }))).not.toThrow();
  });

  test("does not throw when protocol is 'cli'", () => {
    expect(() => logActiveProtocol(makeConfig({ protocol: "cli" }))).not.toThrow();
  });

  test("does not throw when agent config is unset", () => {
    expect(() => logActiveProtocol(makeConfig())).not.toThrow();
  });

  test("is exported from run-initialization module", () => {
    expect(typeof logActiveProtocol).toBe("function");
  });
});
