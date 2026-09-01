/**
 * Tests for ACP-003: Registry integration and config
 *
 * Covers:
 * - createAgentRegistry() always returns AcpAgentAdapter (ACP is the only protocol)
 * - AgentConfig type is exported with correct shape from config/schema
 * - AcpAgentAdapter instances are reused per agent name within a registry
 * - checkAgentHealth() works with ACP adapters
 * - logActiveProtocol() logs the active protocol
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { _acpAdapterDeps, AcpAgentAdapter } from "@/agents/acp/adapter";
import { _registryTestAdapters, checkAgentHealth, createAgentRegistry, getInstalledAgents } from "@/agents/registry";
import type { NaxConfig } from "@/config/schema";
import { DEFAULT_CONFIG } from "@/config/schema";
import { logActiveProtocol } from "@/execution/lifecycle/run-initialization";

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

  test("returns AcpAgentAdapter for 'claude'", () => {
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const agent = registry.getAgent("claude");
    expect(agent).toBeInstanceOf(AcpAgentAdapter);
  });

  test("AcpAgentAdapter name is 'claude' when requested by name", () => {
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const agent = registry.getAgent("claude");
    expect(agent?.name).toBe("claude");
  });

  test("returns AcpAgentAdapter for 'claude' when agent config is unset (default acp)", () => {
    const registry = createAgentRegistry(makeNaxConfig());
    const agent = registry.getAgent("claude");
    expect(agent).toBeInstanceOf(AcpAgentAdapter);
  });

  test("returns undefined for unknown agent name", () => {
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    expect(registry.getAgent("unknown-agent-xyz")).toBeUndefined();
  });

  test("exposes protocol field as 'acp'", () => {
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const defaultRegistry = createAgentRegistry(makeNaxConfig());
    expect(registry.protocol).toBe("acp");
    expect(defaultRegistry.protocol).toBe("acp");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createAgentRegistry — instance reuse
// ─────────────────────────────────────────────────────────────────────────────

describe("createAgentRegistry — instance reuse", () => {
  test("returns the same AcpAgentAdapter instance on repeated getAgent calls", () => {
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const first = registry.getAgent("claude");
    const second = registry.getAgent("claude");
    expect(first).toBe(second);
  });

  test("creates distinct AcpAgentAdapter instances for different agent names", () => {
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const claude = registry.getAgent("claude");
    const codex = registry.getAgent("codex");
    expect(claude).toBeInstanceOf(AcpAgentAdapter);
    expect(codex).toBeInstanceOf(AcpAgentAdapter);
    expect(claude).not.toBe(codex);
  });

  test("separate registry instances do not share AcpAgentAdapter instances", () => {
    const r1 = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const r2 = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    expect(r1.getAgent("claude")).not.toBe(r2.getAgent("claude"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config schema — AgentConfig type
// ─────────────────────────────────────────────────────────────────────────────

describe("Config schema — AgentConfig", () => {
  test("NaxConfig accepts agent.protocol: 'acp'", () => {
    const config: NaxConfig = makeNaxConfig({ agent: { protocol: "acp" } });
    expect(config.agent?.protocol).toBe("acp");
  });

  test("NaxConfig agent field is optional (backward compatibility)", () => {
    const config: NaxConfig = makeNaxConfig({ agent: undefined });
    expect(config.agent).toBeUndefined();
  });

  test("DEFAULT_CONFIG has agent.protocol set to 'acp'", () => {
    expect(DEFAULT_CONFIG.agent?.protocol).toBe("acp");
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

  test("returns health entries for all known agents", async () => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const health = await registry.checkAgentHealth();
    expect(Array.isArray(health)).toBe(true);
    expect(health.length).toBeGreaterThan(0);
  });

  test("each health entry has name, displayName, and installed fields", async () => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const health = await registry.checkAgentHealth();
    for (const entry of health) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.displayName).toBe("string");
      expect(typeof entry.installed).toBe("boolean");
    }
  });

  test("health entry installed is true when binary is on PATH", async () => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const health = await registry.checkAgentHealth();
    const claudeEntry = health.find((e) => e.name === "claude");
    expect(claudeEntry).toBeDefined();
    expect(claudeEntry?.installed).toBe(true);
  });

  test("health entry installed is false when binary is not on PATH", async () => {
    _acpAdapterDeps.which = mock((_name: string) => null);
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const health = await registry.checkAgentHealth();
    const claudeEntry = health.find((e) => e.name === "claude");
    expect(claudeEntry).toBeDefined();
    expect(claudeEntry?.installed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module-level getInstalledAgents / checkAgentHealth (BUG-19)
//
// These used to unconditionally return [] regardless of what was actually
// installed, so the "multi-agent-health" precheck always reported "No
// additional agents detected" no matter what was really on PATH.
// ─────────────────────────────────────────────────────────────────────────────

describe("module-level getInstalledAgents() / checkAgentHealth() (BUG-19)", () => {
  const origWhich = _acpAdapterDeps.which;

  beforeEach(() => {
    // _registryTestAdapters is module-global state shared across test
    // files in the same bun test process — a leaked entry from another
    // file would make "returns empty when nothing is on PATH" flaky.
    _registryTestAdapters.clear();
  });

  afterEach(() => {
    _acpAdapterDeps.which = origWhich;
    _registryTestAdapters.clear();
    mock.restore();
  });

  test("getInstalledAgents returns installed adapters instead of an unconditional []", async () => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
    const installed = await getInstalledAgents();
    expect(installed.length).toBeGreaterThan(0);
    expect(installed.some((a) => a.name === "claude")).toBe(true);
  });

  test("getInstalledAgents returns no acpx agents when nothing is on PATH", async () => {
    _acpAdapterDeps.which = mock((_name: string) => null);
    const installed = await getInstalledAgents();
    // Native is exempt: with no binary, it counts as installed whenever its
    // client resolves (ADR-027 section 3 / Open Question 4). What BUG-19's
    // unconditional [] used to fake is the acpx set staying out.
    expect(installed.filter((a) => a.name !== "native")).toEqual([]);
  });

  test("checkAgentHealth reflects real installed status instead of an unconditional []", async () => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
    const health = await checkAgentHealth();
    expect(health.length).toBeGreaterThan(0);
    const claudeEntry = health.find((e) => e.name === "claude");
    expect(claudeEntry?.installed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// logActiveProtocol — run-initialization logging
// ─────────────────────────────────────────────────────────────────────────────

describe("logActiveProtocol()", () => {
  test("does not throw when protocol is 'acp'", () => {
    expect(() => logActiveProtocol(makeNaxConfig({ agent: { protocol: "acp" } }))).not.toThrow();
  });

  test("does not throw when agent config is unset", () => {
    expect(() => logActiveProtocol(makeNaxConfig())).not.toThrow();
  });

  test("is exported from run-initialization module", () => {
    expect(typeof logActiveProtocol).toBe("function");
  });
});
