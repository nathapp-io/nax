/**
 * Tier-aware fallback targets.
 *
 * The schema is the easy half. The reason these tests assert at the seams and
 * not only at the parse is that widening the schema alone ships an inert
 * feature: the tier would be parsed, filtered, and then dropped by a
 * nextCandidate that returns a bare string.
 */

import { describe, expect, test } from "bun:test";
import { resolveStartAgent, type StartAgentSource } from "@/agents/hop-budget";
import { AgentManager } from "@/agents/manager";
import { resolveFinalDispatch, resolveHopCompleteOptions } from "@/agents/manager-dispatch";
import type { AgentFallbackRecord, HopKind } from "@/agents/manager-types";
import { availableCandidates, credentialCandidates, normaliseFallbackTarget } from "@/agents/swap-decision";
import type { AgentRunOptions, ResolvedCompleteOptions } from "@/agents/types";
import { type AgentManagerConfig, resolveModelForAgent } from "@/config";
import { NaxConfigSchema } from "@/config/schemas";
import type { AdapterFailure } from "@/context/engine";

const none = () => false;

describe("fallback map schema", () => {
  test("accepts plain strings, as today", () => {
    const config = NaxConfigSchema.parse({
      agent: { fallback: { enabled: true, map: { claude: ["codex", "gemini"] } } },
    });
    expect(config.agent?.fallback?.map.claude).toEqual(["codex", "gemini"]);
  });

  test("accepts a { agent, tier } target", () => {
    const config = NaxConfigSchema.parse({
      agent: { fallback: { enabled: true, map: { native: [{ agent: "native", tier: "cheap" }] } } },
    });
    expect(config.agent?.fallback?.map.native).toEqual([{ agent: "native", tier: "cheap" }]);
  });

  test("accepts both forms mixed in one entry", () => {
    const config = NaxConfigSchema.parse({
      agent: { fallback: { enabled: true, map: { claude: ["codex", { agent: "native", tier: "cheap" }] } } },
    });
    expect(config.agent?.fallback?.map.claude).toHaveLength(2);
  });

  test("rejects an object target missing agent", () => {
    expect(() =>
      NaxConfigSchema.parse({
        agent: { fallback: { enabled: true, map: { claude: [{ tier: "cheap" }] } } },
      }),
    ).toThrow();
  });
});

describe("normaliseFallbackTarget", () => {
  test("a string becomes an agent with no tier", () => {
    expect(normaliseFallbackTarget("codex")).toEqual({ agent: "codex" });
  });

  test("an object keeps its tier", () => {
    expect(normaliseFallbackTarget({ agent: "native", tier: "cheap" })).toEqual({ agent: "native", tier: "cheap" });
  });
});

describe("availableCandidates", () => {
  test("plain strings behave exactly as before", () => {
    expect(availableCandidates({ claude: ["codex", "gemini"] }, "claude", none)).toEqual([
      { agent: "codex" },
      { agent: "gemini" },
    ]);
  });

  test("preserves the tier on an object target", () => {
    expect(availableCandidates({ native: [{ agent: "native", tier: "cheap" }] }, "native", none)).toEqual([
      { agent: "native", tier: "cheap" },
    ]);
  });

  test("exclusion still filters by agent name", () => {
    const excluded = (c: string) => c === "codex";
    expect(availableCandidates({ claude: ["codex", { agent: "native", tier: "cheap" }] }, "claude", excluded)).toEqual([
      { agent: "native", tier: "cheap" },
    ]);
  });
});

describe("credentialCandidates", () => {
  test("yields names for both forms, so validateCredentials checks both sides", () => {
    const got = credentialCandidates({ claude: ["codex", { agent: "native", tier: "cheap" }] }, "claude");
    expect([...got].sort()).toEqual(["claude", "codex", "native"]);
  });
});

describe("nextCandidate", () => {
  function manager(map: Record<string, unknown[]>) {
    const config = NaxConfigSchema.parse({
      agent: { default: "claude", fallback: { enabled: true, map } },
    });
    return new AgentManager(config);
  }

  test("returns a bare agent for a plain-string target", () => {
    expect(manager({ claude: ["codex"] }).nextCandidate("claude", 0)).toEqual({ agent: "codex" });
  });

  test("returns the tier for an object target", () => {
    expect(manager({ claude: [{ agent: "native", tier: "cheap" }] }).nextCandidate("claude", 0)).toEqual({
      agent: "native",
      tier: "cheap",
    });
  });

  test("returns null when the chain is empty", () => {
    expect(manager({ claude: [] }).nextCandidate("claude", 0)).toBeNull();
  });
});

describe("resolveStartAgent", () => {
  const tieredSource: StartAgentSource = {
    isUnavailable: (agent) => agent === "claude",
    nextCandidate: () => ({ agent: "native", tier: "cheap" }),
  };

  test("a healthy primary is returned as a tier-less target", () => {
    expect(resolveStartAgent(tieredSource, "codex", true, undefined, null)).toEqual({ agent: "codex" });
  });

  test("an unavailable primary with fallback enabled returns the candidate with its tier", () => {
    expect(resolveStartAgent(tieredSource, "claude", true, undefined, null)).toEqual({
      agent: "native",
      tier: "cheap",
    });
  });

  test("fallback off keeps the primary even when unavailable (the toggle must win)", () => {
    expect(resolveStartAgent(tieredSource, "claude", false, undefined, null)).toEqual({ agent: "claude" });
  });

  test("no candidate left returns the dead primary", () => {
    const empty: StartAgentSource = { isUnavailable: () => true, nextCandidate: () => null };
    expect(resolveStartAgent(empty, "claude", true, undefined, null)).toEqual({ agent: "claude" });
  });
});

describe("dead-primary start preserves a named tier on the run path", () => {
  const AVAIL_FAILURE: AdapterFailure = {
    category: "availability",
    outcome: "fail-quota",
    retriable: false,
    message: "quota exceeded",
  };

  function makeRunOptions(config: AgentManagerConfig): AgentRunOptions {
    return {
      prompt: "do it",
      workdir: "/tmp",
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      timeoutSeconds: 60,
      config,
    };
  }

  test("an op starting on a dead primary dispatches the fallback agent at its named tier", async () => {
    // A multi-op story where the primary dies in op 1 must start op 2 on the
    // fallback agent AT THE TIER the fallback map named — not at the caller's
    // effective tier. The manager seeds currentHopKind from the start target,
    // and hopTier reads the tier off the primary kind.
    const config = NaxConfigSchema.parse({
      agent: { default: "claude", fallback: { enabled: true, map: { claude: [{ agent: "native", tier: "cheap" }] } } },
    });
    const manager = new AgentManager(config);
    manager.markUnavailable("claude", AVAIL_FAILURE);

    const hops: { agent: string; hopKind: HopKind }[] = [];
    const outcome = await manager.runWithFallback({
      runOptions: makeRunOptions(config),
      executeHop: async (agent, bundle, hopKind) => {
        hops.push({ agent, hopKind });
        return {
          result: { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
          bundle,
        };
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(hops).toHaveLength(1);
    expect(hops[0].agent).toBe("native");
    expect(hops[0].hopKind).toEqual({ kind: "primary", tier: "cheap" });
  });

  test("a plain-string fallback starts at the caller's effective tier, as before", async () => {
    const config = NaxConfigSchema.parse({
      agent: { default: "claude", fallback: { enabled: true, map: { claude: ["codex"] } } },
    });
    const manager = new AgentManager(config);
    manager.markUnavailable("claude", AVAIL_FAILURE);

    const hops: { agent: string; hopKind: HopKind }[] = [];
    await manager.runWithFallback({
      runOptions: makeRunOptions(config),
      executeHop: async (agent, bundle, hopKind) => {
        hops.push({ agent, hopKind });
        return {
          result: { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
          bundle,
        };
      },
    });

    expect(hops[0].agent).toBe("codex");
    expect(hops[0].hopKind).toEqual({ kind: "primary" });
  });
});

describe("resolveHopCompleteOptions", () => {
  const base: ResolvedCompleteOptions = {
    modelDef: { provider: "anthropic", model: "primary-model" },
    modelDefFor: (agent: string, tier?: string) => ({ provider: "p", model: `${agent}:${tier ?? "default"}` }),
    workdir: "/tmp",
    resolvedPermissions: { mode: "approve-all" },
  };

  test("the primary hop is untouched", () => {
    expect(resolveHopCompleteOptions(base, "claude", "claude").modelDef.model).toBe("primary-model");
  });

  test("a swapped hop with no tier resolves the agent's default, as today", () => {
    expect(resolveHopCompleteOptions(base, "codex", "claude").modelDef.model).toBe("codex:default");
  });

  test("a swapped hop passes its tier through to modelDefFor", () => {
    // The assertion that matters: the tier must REACH the dispatch. Asserting
    // only that the schema parsed would pass while the feature is inert.
    expect(resolveHopCompleteOptions(base, "native", "claude", "cheap").modelDef.model).toBe("native:cheap");
  });
});

describe("an unknown tier on a fallback target", () => {
  test("throws MODEL_NOT_FOUND rather than silently falling back to balanced", () => {
    // resolveModelForAgent throws when neither the agent nor the default agent
    // defines the tier. Swallowing that would run the hop on a model the user
    // never asked for, which is worse than failing.
    const models = { claude: { balanced: "claude-sonnet-5" }, native: { cheap: "opencode-go/glm-5" } };
    expect(() => resolveModelForAgent(models, "native", "no-such-tier", "claude")).toThrow(
      /MODEL_NOT_FOUND|no-such-tier/,
    );
  });

  test("a tier the agent lacks falls back to the default agent's entry before throwing", () => {
    const models = { claude: { premium: "claude-opus-5" }, native: { cheap: "opencode-go/glm-5" } };
    expect(resolveModelForAgent(models, "native", "premium", "claude").model).toBe("claude-opus-5");
  });
});

describe("resolveFinalDispatch", () => {
  const base: ResolvedCompleteOptions = {
    modelDef: { provider: "anthropic", model: "primary-model" },
    modelDefFor: (agent: string, tier?: string) => ({ provider: "p", model: `${agent}:${tier ?? "default"}` }),
    modelTier: "balanced",
    workdir: "/tmp",
    resolvedPermissions: { mode: "approve-all" },
  };
  const swapped: AgentFallbackRecord[] = [
    {
      priorAgent: "claude",
      newAgent: "native",
      hop: 1,
      outcome: "fail-quota",
      category: "availability",
      timestamp: "2026-09-02T00:00:00.000Z",
      costUsd: 0,
    },
  ];

  test("the cost row records the model the swapped hop actually ran", () => {
    // Without threading finalTier this is "native:default" — a model that
    // never ran, billed against the run.
    expect(resolveFinalDispatch(base, "claude", swapped, "cheap").options.modelDef.model).toBe("native:cheap");
  });

  test("a tier-carrying swap also records that tier, so model and modelTier agree", () => {
    // The dispatched model is "native:cheap"; reporting the primary's
    // "balanced" (or nothing) alongside it would record a tier that never ran.
    const out = resolveFinalDispatch(base, "claude", swapped, "cheap").options;
    expect(out.modelDef.model).toBe("native:cheap");
    expect(out.modelTier).toBe("cheap");
  });

  test("no tier means today's behaviour", () => {
    expect(resolveFinalDispatch(base, "claude", swapped).options.modelDef.model).toBe("native:default");
  });

  test("no tier leaves modelTier as the base had it", () => {
    expect(resolveFinalDispatch(base, "claude", swapped).options.modelTier).toBe("balanced");
  });
});
