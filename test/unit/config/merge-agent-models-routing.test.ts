/**
 * Unit tests for mergePackageConfig — agent, models, routing whitelist expansion (#291)
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { mergePackageConfig } from "../../../src/config/merge";
import type { NaxConfig } from "../../../src/config/schema";

function makeRoot(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    agent: {
      protocol: "acp",
      maxInteractionTurns: 10,
      promptAudit: { enabled: false },
    },
    models: {
      claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
    },
    routing: {
      strategy: "keyword",
      llm: {
        model: "fast",
        fallbackToKeywords: true,
        cacheDecisions: true,
        mode: "hybrid",
        timeoutMs: 30000,
      },
    },
  };
}

describe("mergePackageConfig — agent section", () => {
  test("merges agent.protocol when packageOverride provides it", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, { agent: { protocol: "acp" } } as Partial<NaxConfig>);
    expect(result.agent?.protocol).toBe("acp");
    expect(result.agent?.maxInteractionTurns).toBe(10); // root preserved
  });

  test("merges agent.maxInteractionTurns independently", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, { agent: { maxInteractionTurns: 5 } } as Partial<NaxConfig>);
    expect(result.agent?.maxInteractionTurns).toBe(5);
    expect(result.agent?.protocol).toBe("acp"); // root preserved
  });

  test("deep-merges agent.promptAudit: enables audit for a package", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      agent: { promptAudit: { enabled: true, dir: "/tmp/audit" } },
    } as Partial<NaxConfig>);
    expect(result.agent?.promptAudit?.enabled).toBe(true);
    expect(result.agent?.promptAudit?.dir).toBe("/tmp/audit");
  });

  test("deep-merges agent.promptAudit: override enabled only, dir fallback from root", () => {
    const root = {
      ...makeRoot(),
      agent: { protocol: "acp" as const, maxInteractionTurns: 10, promptAudit: { enabled: false, dir: "/root/audit" } },
    };
    const result = mergePackageConfig(root, {
      agent: { promptAudit: { enabled: true } },
    } as Partial<NaxConfig>);
    expect(result.agent?.promptAudit?.enabled).toBe(true);
    expect(result.agent?.promptAudit?.dir).toBe("/root/audit"); // root dir preserved
  });

  test("returns root.agent unchanged when packageOverride has no agent field", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, { quality: { commands: { test: "npm test" } } } as Partial<NaxConfig>);
    expect(result.agent).toBe(root.agent); // exact reference preserved via spread
  });

  test("does not mutate root.agent", () => {
    const root = makeRoot();
    const origProtocol = root.agent?.protocol;
    mergePackageConfig(root, { agent: { maxInteractionTurns: 20 } } as Partial<NaxConfig>);
    expect(root.agent?.protocol).toBe(origProtocol);
  });
});

describe("mergePackageConfig — models section", () => {
  test("merges models by overriding a specific agent's tier mapping", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      models: { claude: { fast: "sonnet", balanced: "opus", powerful: "opus" } },
    } as Partial<NaxConfig>);
    expect(result.models.claude?.fast).toBe("sonnet");
    expect(result.models.claude?.balanced).toBe("opus");
  });

  test("adds a new agent model entry while preserving existing ones", () => {
    const root = makeRoot();
    const override = { models: { "custom-agent": { fast: "haiku", balanced: "sonnet", powerful: "opus" } } };
    const result = mergePackageConfig(root, override as unknown as Partial<NaxConfig>);
    expect(result.models["custom-agent"]?.fast).toBe("haiku");
    expect(result.models.claude?.fast).toBe("haiku"); // root entry preserved
  });

  test("returns root.models unchanged when packageOverride has no models field", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, { quality: { commands: { test: "x" } } } as Partial<NaxConfig>);
    expect(result.models).toBe(root.models);
  });

  test("does not mutate root.models", () => {
    const root = makeRoot();
    const origFast = root.models.claude?.fast;
    const override = { models: { claude: { fast: "sonnet", balanced: "sonnet", powerful: "opus" } } };
    mergePackageConfig(root, override as unknown as Partial<NaxConfig>);
    expect(root.models.claude?.fast).toBe(origFast);
  });
});

describe("mergePackageConfig — routing section", () => {
  test("merges routing.strategy for a package", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, { routing: { strategy: "llm" } } as Partial<NaxConfig>);
    expect(result.routing?.strategy).toBe("llm");
    expect(result.routing?.llm).toEqual(root.routing?.llm); // root llm preserved
  });

  test("deep-merges routing.llm fields", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      routing: { llm: { model: "balanced", timeoutMs: 60000 } },
    } as Partial<NaxConfig>);
    expect(result.routing?.llm?.model).toBe("balanced");
    expect(result.routing?.llm?.timeoutMs).toBe(60000);
    expect(result.routing?.llm?.fallbackToKeywords).toBe(true); // root preserved
    expect(result.routing?.strategy).toBe("keyword"); // root preserved
  });

  test("returns root.routing unchanged when packageOverride has no routing field", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, { quality: { commands: { test: "x" } } } as Partial<NaxConfig>);
    expect(result.routing).toBe(root.routing);
  });

  test("does not mutate root.routing", () => {
    const root = makeRoot();
    const origStrategy = root.routing?.strategy;
    mergePackageConfig(root, { routing: { strategy: "llm" } } as Partial<NaxConfig>);
    expect(root.routing?.strategy).toBe(origStrategy);
  });
});

describe("mergePackageConfig — combined override", () => {
  test("merges agent + models + routing + quality simultaneously", () => {
    const root = makeRoot();
    const override = {
      agent: { maxInteractionTurns: 20 },
      models: { claude: { fast: "sonnet", balanced: "opus", powerful: "opus" } },
      routing: { strategy: "llm" },
      quality: { commands: { test: "npm test" } },
    };
    const result = mergePackageConfig(root, override as unknown as Partial<NaxConfig>);

    expect(result.agent?.protocol).toBe("acp");
    expect(result.agent?.maxInteractionTurns).toBe(20);
    expect(result.models.claude?.fast).toBe("sonnet");
    expect(result.routing?.strategy).toBe("llm");
    expect(result.quality.commands.test).toBe("npm test");
  });
});
