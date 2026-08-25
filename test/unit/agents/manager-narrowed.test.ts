import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _registryTestAdapters } from "@/agents/registry";
import { createAgentRegistry } from "@/agents/registry";
import type { AgentAdapter } from "@/agents/types";
import { resolveDefaultAgent } from "@/agents/utils";
import { agentManagerConfigSelector } from "@/config";
import type { NaxConfig } from "@/config/schema";
import type { AgentManagerConfig } from "@/config/selectors";
import { type DeepPartial, makeAgentAdapter, makeNaxConfig } from "@test/helpers";

const makeSlicedConfig = (
  agent: DeepPartial<NaxConfig["agent"]> = {},
  execution: DeepPartial<NaxConfig["execution"]> = {},
): AgentManagerConfig => agentManagerConfigSelector.select(makeNaxConfig({ agent, execution }));

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
      mockAdapter = makeAgentAdapter({ name: "mock", displayName: "Mock Agent", binary: "mock" });
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
