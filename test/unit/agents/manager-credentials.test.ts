import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import { NaxConfigSchema } from "../../../src/config/schemas";
import type { AgentAdapter } from "../../../src/agents/types";

function stubAdapter(name: string, hasCreds: boolean): AgentAdapter {
  return {
    name,
    displayName: name,
    binary: name,
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"] as const,
      maxContextTokens: 100000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(),
    },
    isInstalled: async () => true,
    hasCredentials: async () => hasCreds,
    run: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 }),
    buildCommand: () => [],
    plan: async () => ({ spec: "", cost: 0 }) as never,
    decompose: async () => ({ stories: [] }) as never,
    complete: async () => ({ output: "", costUsd: 0, source: "estimated" as const }),
    deriveSessionName: () => "",
    closePhysicalSession: async () => {},
    closeSession: async () => {},
  };
}

describe("AgentManager.validateCredentials (#518)", () => {
  test("missing fallback candidate is pruned with a warning", async () => {
    const config = NaxConfigSchema.parse({
      agent: {
        default: "claude",
        fallback: { enabled: true, map: { claude: ["codex"] } },
      },
    });
    const registry = {
      getAgent: (n: string) => (n === "claude" ? stubAdapter("claude", true) : stubAdapter("codex", false)),
      getInstalledAgents: async () => [],
      checkAgentHealth: async () => [],
      protocol: "acp" as const,
      resetStoryState: () => {},
    };
    const warn = mock(() => {});
    const manager = new AgentManager(config, registry, { logger: { warn } });
    await manager.validateCredentials();
    expect(
      manager.resolveFallbackChain("claude", { category: "availability", outcome: "fail-auth", message: "", retriable: false }),
    ).not.toContain("codex");
    expect(warn).toHaveBeenCalled();
  });

  test("missing primary throws NaxError", async () => {
    const config = NaxConfigSchema.parse({ agent: { default: "claude" } });
    const registry = {
      getAgent: () => stubAdapter("claude", false),
      getInstalledAgents: async () => [],
      checkAgentHealth: async () => [],
      protocol: "acp" as const,
      resetStoryState: () => {},
    };
    const manager = new AgentManager(config, registry);
    await expect(manager.validateCredentials()).rejects.toThrow(/credentials/i);
  });

  test("adapter without hasCredentials is treated as credentialed", async () => {
    const adapter = stubAdapter("claude", true);
    delete (adapter as Partial<AgentAdapter>).hasCredentials;
    const config = NaxConfigSchema.parse({ agent: { default: "claude" } });
    const registry = {
      getAgent: () => adapter,
      getInstalledAgents: async () => [],
      checkAgentHealth: async () => [],
      protocol: "acp" as const,
      resetStoryState: () => {},
    };
    const manager = new AgentManager(config, registry);
    await expect(manager.validateCredentials()).resolves.toBeUndefined();
  });
});
