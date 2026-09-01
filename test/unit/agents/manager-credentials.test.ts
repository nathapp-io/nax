import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter } from "@test/helpers";
import { AgentManager } from "@/agents/manager";
import type { AgentAdapter } from "@/agents/types";
import { NaxConfigSchema } from "@/config/schemas";

function stubAdapter(name: string, hasCreds: boolean): AgentAdapter {
  return makeAgentAdapter({
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
    buildCommand: () => [],
    complete: async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
    closeSession: async () => {},
  });
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
    };
    const warn = mock(() => {});
    const info = mock(() => {});
    const manager = new AgentManager(config, registry, { logger: { warn, info } });
    await manager.validateCredentials();
    expect(
      manager
        .resolveFallbackChain("claude", {
          category: "availability",
          outcome: "fail-auth",
          message: "",
          retriable: false,
        })
        .map((t) => t.agent),
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
    };
    const manager = new AgentManager(config, registry);
    await expect(manager.validateCredentials()).resolves.toBeUndefined();
  });
});

describe("native agent credential pruning (Phase A plan 3)", () => {
  test("an uncredentialed native fallback candidate is pruned", async () => {
    const config = NaxConfigSchema.parse({
      agent: { default: "claude", fallback: { enabled: true, map: { claude: ["native"] } } },
    });
    const registry = {
      getAgent: (n: string) => (n === "claude" ? stubAdapter("claude", true) : stubAdapter("native", false)),
      getInstalledAgents: async () => [],
      checkAgentHealth: async () => [],
      protocol: "acp" as const,
    };
    const manager = new AgentManager(config, registry);

    await manager.validateCredentials();

    expect(
      manager
        .resolveFallbackChain("claude", {
          category: "availability",
          outcome: "fail-auth",
          message: "",
          retriable: false,
        })
        .map((t) => t.agent),
    ).not.toContain("native");
  });

  test("an uncredentialed native PRIMARY throws AGENT_CREDENTIALS_MISSING", async () => {
    const config = NaxConfigSchema.parse({
      agent: { default: "native", fallback: { enabled: true, map: {} } },
    });
    const registry = {
      getAgent: () => stubAdapter("native", false),
      getInstalledAgents: async () => [],
      checkAgentHealth: async () => [],
      protocol: "acp" as const,
    };
    const manager = new AgentManager(config, registry);

    await expect(manager.validateCredentials()).rejects.toMatchObject({ code: "AGENT_CREDENTIALS_MISSING" });
  });
});
