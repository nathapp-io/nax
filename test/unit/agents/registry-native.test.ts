/**
 * The registry discriminates by agent name (ADR-027 section 3).
 *
 * Note the deliberate wrinkle: getAllAgents/getInstalledAgents are config-less
 * by design and cannot consult the protocol gate, so native appears in their
 * listings regardless. The gate bites at config validation and
 * createAgentRegistry.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@nathapp/nax-ai";
import { makeNaxConfig } from "@test/helpers";
import { AcpAgentAdapter } from "@/agents/acp/adapter";
import { NativeAgentAdapter } from "@/agents/native";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { createAgentRegistry, getAllAgents, KNOWN_AGENT_NAMES } from "@/agents/registry";
import type { ProviderCatalogOverride } from "@/config/schema-types";

const REAL_BUILD = _clientDeps.build;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

function fakeNativeClient(): Client {
  const model = {
    id: "deepseek-flash",
    provider: "opencode-go",
    protocol: "openai-completions",
    pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    contextWindow: 1_000_000,
    supportsTools: true,
    thinkingLevels: [],
  } as const;
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => model.pricing,
    stream: async function* stream() {},
    complete: async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" }),
    validate: () => {},
  };
}

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

describe("registry catalog-override wiring", () => {
  test("threads agent.native.catalogOverrides from config into the client build", async () => {
    const overrides: ProviderCatalogOverride[] = [
      {
        provider: "opencode-go",
        models: [
          {
            id: "deepseek-flash",
            protocol: "openai-completions",
            contextWindow: 1_000_000,
            supportsTools: true,
            thinkingLevels: ["off"],
            pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
          },
        ],
      },
    ];
    const config = makeNaxConfig({
      agent: { protocol: "hybrid", default: "native", native: { catalogOverrides: overrides } },
    });
    const registry = createAgentRegistry(config);
    let seen: readonly ProviderCatalogOverride[] | undefined;
    _clientDeps.build = async (received) => {
      seen = received;
      return fakeNativeClient();
    };

    await registry.getAgent("native")?.complete("hi", {
      modelDef: { provider: "opencode-go", model: "opencode-go/deepseek-flash" },
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
    });

    expect(seen).toEqual(overrides);
  });
});
