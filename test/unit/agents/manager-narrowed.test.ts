import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { _registryTestAdapters } from "../../../src/agents/registry";
import type { AgentAdapter } from "../../../src/agents/types";
import { resolveDefaultAgent } from "../../../src/agents/utils";
import { createAgentRegistry } from "../../../src/agents/registry";
import { AgentManagerConfig } from "../../../src/config/selectors";

const makeSlicedConfig = (agent: Record<string, unknown> = {}, execution: Record<string, unknown> = {}): AgentManagerConfig =>
  ({ agent: agent as AgentManagerConfig["agent"], execution: execution as unknown as AgentManagerConfig["execution"] });

describe("AgentManager — narrowed config (Pick<NaxConfig, 'agent' | 'execution'>)", () => {
  describe("resolveDefaultAgent", () => {
    test("returns default agent from config", () => {
      const config = makeSlicedConfig({ default: "codex" });
      expect(resolveDefaultAgent(config)).toBe("codex");
    });

    test("returns fallback when default is empty", () => {
      const config = makeSlicedConfig({ default: "" });
      expect(resolveDefaultAgent(config)).toBe("claude");
    });

    test("returns fallback when no agent config", () => {
      const config = makeSlicedConfig({});
      expect(resolveDefaultAgent(config)).toBe("claude");
    });
  });

  describe("createAgentRegistry", () => {
    let mockAdapter: AgentAdapter;

    beforeEach(() => {
      mockAdapter = {
        name: "mock",
        displayName: "Mock Agent",
        complete: async () => ({ output: "", exitCode: 0, costUsd: 0, source: "exact" }),
        isInstalled: async () => true,
        binary: "mock",
        capabilities: { supportedTiers: [], maxContextTokens: 0, features: new Set() },
        buildCommand: () => [],
        openSession: async () => ({ id: "", agentName: "mock", close: async () => {} }),
        closeSession: async () => {},
        sendTurn: async () => ({ output: "", exitCode: 0, costUsd: 0, source: "exact", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0, internalRoundTrips: 0 }),
      };
    });

    afterEach(() => {
      _registryTestAdapters.delete("mock");
    });

    test("creates registry with sliced config", () => {
      const config = makeSlicedConfig({ default: "mock" });
      const registry = createAgentRegistry(config);
      expect(registry.protocol).toBe("acp");
    });

    test("creates registry with sliced config — safe with no agent.default", () => {
      const config = makeSlicedConfig({}); // no default, no agent
      const registry = createAgentRegistry(config);
      expect(registry.protocol).toBe("acp");
    });

    test("test adapter takes precedence in registry", () => {
      _registryTestAdapters.set("mock", mockAdapter);
      const config = makeSlicedConfig({});
      const registry = createAgentRegistry(config);
      expect(registry.getAgent("mock")).toBe(mockAdapter);
    });

    test("returns undefined for unknown agent", () => {
      const config = makeSlicedConfig({});
      const registry = createAgentRegistry(config);
      expect(registry.getAgent("nonexistent")).toBeUndefined();
    });
  });
});