/**
 * The registry discriminates by agent name (ADR-027 section 3).
 *
 * Note the deliberate wrinkle: getAllAgents/getInstalledAgents are config-less
 * by design and cannot consult the protocol gate, so native appears in their
 * listings regardless. The gate bites at config validation and
 * createAgentRegistry.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { AcpAgentAdapter } from "@/agents/acp/adapter";
import { NativeAgentAdapter } from "@/agents/native";
import { createAgentRegistry, getAllAgents, KNOWN_AGENT_NAMES } from "@/agents/registry";

describe("registry discrimination", () => {
  test("knows the native agent", () => {
    expect(KNOWN_AGENT_NAMES).toContain("native");
  });

  test("builds a NativeAgentAdapter for native and AcpAgentAdapter for the rest", () => {
    const byName = new Map(getAllAgents().map((a) => [a.name, a]));

    expect(byName.get("native")).toBeInstanceOf(NativeAgentAdapter);
    expect(byName.get("claude")).toBeInstanceOf(AcpAgentAdapter);
    expect(byName.get("codex")).toBeInstanceOf(AcpAgentAdapter);
  });

  test("resolves native through the config-aware registry too", () => {
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "hybrid", default: "claude" } }));

    expect(registry.getAgent("native")).toBeInstanceOf(NativeAgentAdapter);
    // Builtin tiers, not the configured ones: the manager's config slice
    // deliberately excludes `models` (ADR-019).
    expect(registry.getAgent("native")?.capabilities.supportedTiers).toEqual(["fast", "balanced", "powerful"]);
  });

  test("the native adapter reports no binary, so nothing tries to spawn it", () => {
    const native = getAllAgents().find((a) => a.name === "native");
    expect(native?.binary).toBe("");
  });
});
