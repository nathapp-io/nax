/**
 * Tier-aware fallback targets.
 *
 * The schema is the easy half. The reason these tests assert at the seams and
 * not only at the parse is that widening the schema alone ships an inert
 * feature: the tier would be parsed, filtered, and then dropped by a
 * nextCandidate that returns a bare string.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolveStartAgent, type StartAgentSource } from "@/agents/hop-budget";
import { _agentManagerDeps, AgentManager } from "@/agents/manager";
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
      agent: { protocol: "hybrid", fallback: { enabled: true, map: { native: [{ agent: "native", tier: "cheap" }] } } },
    });
    expect(config.agent?.fallback?.map.native).toEqual([{ agent: "native", tier: "cheap" }]);
  });

  test("accepts both forms mixed in one entry", () => {
    const config = NaxConfigSchema.parse({
      agent: {
        protocol: "hybrid",
        fallback: { enabled: true, map: { claude: ["codex", { agent: "native", tier: "cheap" }] } },
      },
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

  test("accepts a { agent, model } target — the ConfiguredModel spelling", () => {
    const config = NaxConfigSchema.parse({
      agent: {
        protocol: "hybrid",
        fallback: { enabled: true, map: { native: [{ agent: "native", model: "balanced" }] } },
      },
    });
    expect(config.agent?.fallback?.map.native).toEqual([{ agent: "native", model: "balanced" }]);
  });

  test("{ agent, model } also accepts a literal provider/model id", () => {
    const config = NaxConfigSchema.parse({
      agent: {
        protocol: "hybrid",
        fallback: { enabled: true, map: { native: [{ agent: "native", model: "openrouter/z-ai/glm-5.3-flash" }] } },
      },
    });
    expect(config.agent?.fallback?.map.native).toEqual([{ agent: "native", model: "openrouter/z-ai/glm-5.3-flash" }]);
  });
});

describe("normaliseFallbackTarget", () => {
  test("a string becomes an agent with no tier", () => {
    expect(normaliseFallbackTarget("codex")).toEqual({ agent: "codex" });
  });

  test("an object keeps its tier", () => {
    expect(normaliseFallbackTarget({ agent: "native", tier: "cheap" })).toEqual({ agent: "native", tier: "cheap" });
  });

  test("a { agent, model } object keeps its model, uninterpreted", () => {
    expect(normaliseFallbackTarget({ agent: "native", model: "balanced" })).toEqual({
      agent: "native",
      model: "balanced",
    });
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
  function manager(map: Record<string, unknown[]>, protocol?: "hybrid") {
    const config = NaxConfigSchema.parse({
      agent: { protocol, default: "claude", fallback: { enabled: true, map } },
    });
    return new AgentManager(config);
  }

  test("returns a bare agent for a plain-string target", () => {
    expect(manager({ claude: ["codex"] }).nextCandidate("claude", 0)).toEqual({ agent: "codex" });
  });

  test("returns the tier for an object target", () => {
    expect(manager({ claude: [{ agent: "native", tier: "cheap" }] }, "hybrid").nextCandidate("claude", 0)).toEqual({
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
      agent: {
        protocol: "hybrid",
        default: "claude",
        fallback: { enabled: true, map: { claude: [{ agent: "native", tier: "cheap" }] } },
      },
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

describe("tiered fallback retries", () => {
  const AVAIL_FAILURE: AdapterFailure = {
    category: "availability",
    outcome: "fail-auth",
    retriable: false,
    message: "authentication failed",
  };
  const TIMEOUT_FAILURE: AdapterFailure = {
    category: "quality",
    outcome: "fail-timeout",
    retriable: true,
    message: "wall-clock timeout exceeded",
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

  test("a same-agent timeout retry preserves the fallback target's tier", async () => {
    const config = NaxConfigSchema.parse({
      agent: {
        protocol: "hybrid",
        default: "claude",
        fallback: { enabled: true, map: { claude: [{ agent: "native", tier: "cheap" }] } },
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
      },
    });
    const manager = new AgentManager(config);
    const hops: { agent: string; hopKind: HopKind }[] = [];

    await manager.runWithFallback({
      runOptions: makeRunOptions(config),
      executeHop: async (agent, bundle, hopKind) => {
        hops.push({ agent, hopKind });
        const result =
          hops.length === 1
            ? {
                success: false,
                exitCode: 1,
                output: "auth",
                rateLimited: false,
                durationMs: 0,
                estimatedCostUsd: 0,
                adapterFailure: AVAIL_FAILURE,
              }
            : hops.length === 2
              ? {
                  success: false,
                  exitCode: 1,
                  output: "timeout",
                  rateLimited: false,
                  durationMs: 0,
                  estimatedCostUsd: 0,
                  adapterFailure: TIMEOUT_FAILURE,
                }
              : { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 };
        return { result, bundle };
      },
    });

    expect(hops).toEqual([
      { agent: "claude", hopKind: { kind: "primary" } },
      { agent: "native", hopKind: { kind: "swap", failure: AVAIL_FAILURE, tier: "cheap" } },
      { agent: "native", hopKind: { kind: "timeout-retry", attempt: 1, tier: "cheap" } },
    ]);
  });
});

describe("a same-agent, different-tier fallback target (native -> {agent: native, tier: glm})", () => {
  // The schema accepts this shape and normaliseFallbackTarget/availableCandidates preserve
  // it, but nextCandidate's exclusion was keyed on the bare agent name and markUnavailable's
  // cooldown was keyed on the bare agent name too — so a same-agent target was filtered out
  // before its tier was ever considered, and shouldSwap could say yes while nextCandidate
  // always returned null. This reproduces the production call shape: nextCandidate is called
  // with the CURRENT agent as `exclude`, after markUnavailable has already run for this hop.
  const RATE_LIMIT_FAILURE: AdapterFailure = {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: "rate limited",
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

  test("nextCandidate(current, hops, current) still returns the different-tier target", () => {
    const config = NaxConfigSchema.parse({
      agent: {
        protocol: "hybrid",
        default: "native",
        fallback: { enabled: true, map: { native: [{ agent: "native", tier: "glm" }] } },
      },
    });
    const manager = new AgentManager(config);

    expect(manager.nextCandidate("native", 0, "native")).toEqual({ agent: "native", tier: "glm" });
  });

  test("markUnavailable(agent) does not cool down a different tier of the same agent", () => {
    const config = NaxConfigSchema.parse({
      agent: {
        protocol: "hybrid",
        default: "native",
        fallback: { enabled: true, map: { native: [{ agent: "native", tier: "glm" }] } },
      },
    });
    const manager = new AgentManager(config);

    manager.markUnavailable("native", RATE_LIMIT_FAILURE);

    expect(manager.nextCandidate("native", 0, "native")).toEqual({ agent: "native", tier: "glm" });
  });

  test("the swap actually dispatches to native at tier glm on the second hop", async () => {
    const config = NaxConfigSchema.parse({
      agent: {
        protocol: "hybrid",
        default: "native",
        fallback: { enabled: true, map: { native: [{ agent: "native", tier: "glm" }] } },
      },
    });
    const manager = new AgentManager(config);

    const hops: { agent: string; hopKind: HopKind }[] = [];
    const outcome = await manager.runWithFallback({
      runOptions: makeRunOptions(config),
      executeHop: async (agent, bundle, hopKind) => {
        hops.push({ agent, hopKind });
        const result =
          hops.length === 1
            ? {
                success: false,
                exitCode: 1,
                output: "rate limited",
                rateLimited: true,
                durationMs: 0,
                estimatedCostUsd: 0,
                adapterFailure: RATE_LIMIT_FAILURE,
              }
            : { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 };
        return { result, bundle };
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(hops).toEqual([
      { agent: "native", hopKind: { kind: "primary" } },
      { agent: "native", hopKind: { kind: "swap", failure: RATE_LIMIT_FAILURE, tier: "glm" } },
    ]);
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

  test("a swapped hop dispatches a literal model pin instead of consulting the tier map", () => {
    // modelDefFor resolves THROUGH the tier map, so it cannot serve a pin that
    // names no tier — it would answer "native:default", the caller's own
    // effective tier under a different name. The pin must win outright.
    const pinned = resolveHopCompleteOptions(
      base,
      "native",
      "claude",
      undefined,
      "openrouter/z-ai/glm-5.3-flash[high]",
    );
    expect(pinned.modelDef.model).toBe("openrouter/z-ai/glm-5.3-flash[high]");
    expect(pinned.modelDef.model).not.toBe("native:default");
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

describe("model-identity-aware fallback exclusion", () => {
  // Follow-up to the tier-identity fix above: models.native can point two
  // different tiers at the SAME underlying model (e.g. "fast" and "balanced"
  // both resolving to one minimax entry). Keying exclusion/cooldown on tier
  // name alone lets a swap "succeed" onto a target that is really the same
  // dead provider under a different tier name. AgentManager resolves this via
  // an injected `models` map (fallback-model-identity.ts) — never through
  // AgentManagerConfig/agentManagerConfigSelector, which excludes `models`.
  const RATE_LIMIT_FAILURE: AdapterFailure = {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: "rate limited",
  };
  const SAME_MODEL = { native: { fast: "minimax/MiniMax-M2.7", balanced: "minimax/MiniMax-M2.7" } };
  const DIFFERENT_MODEL = { native: { fast: "minimax/MiniMax-M2.7", balanced: "openrouter/z-ai/glm-5.3-flash" } };

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

  const originalSleep = _agentManagerDeps.sleep;
  afterEach(() => {
    _agentManagerDeps.sleep = originalSleep;
  });
  /** defaultRetryStrategy backs off fail-rate-limit before giving up — avoid real waits. */
  function stubSleep(): void {
    _agentManagerDeps.sleep = async () => {};
  }

  describe("nextCandidate / isUnavailable (unit level)", () => {
    test("marking one tier unavailable also cools down a different tier resolving to the SAME model", () => {
      const config = NaxConfigSchema.parse({
        agent: {
          protocol: "hybrid",
          default: "native",
          fallback: { enabled: true, map: { native: [{ agent: "native", tier: "balanced" }] } },
        },
      });
      const manager = new AgentManager(config, undefined, { models: SAME_MODEL });

      manager.markUnavailable("native", RATE_LIMIT_FAILURE, "fast");

      expect(manager.isUnavailable("native", "balanced")).toBe(true);
      expect(manager.nextCandidate("native", 0, "native", "fast")).toBeNull();
    });

    test("marking one tier unavailable leaves a different tier resolving to a DIFFERENT model untouched", () => {
      const config = NaxConfigSchema.parse({
        agent: {
          protocol: "hybrid",
          default: "native",
          fallback: { enabled: true, map: { native: [{ agent: "native", tier: "balanced" }] } },
        },
      });
      const manager = new AgentManager(config, undefined, { models: DIFFERENT_MODEL });

      manager.markUnavailable("native", RATE_LIMIT_FAILURE, "fast");

      expect(manager.isUnavailable("native", "balanced")).toBe(false);
      expect(manager.nextCandidate("native", 0, "native", "fast")).toEqual({ agent: "native", tier: "balanced" });
    });
  });

  // These two hop chains start on "claude" (not "native") deliberately: a HEALTHY
  // primary's own first hop carries no tier in HopKind (AgentRunOptions.modelTier is
  // caller-only context that markUnavailable/nextCandidate never see — threading it in
  // was tried and reverted, see the "known limitation" note in the PR description,
  // because it narrows markUnavailable's cooldown key from bare-agent to agent+tier,
  // which broke resolveStartAgent's dead-primary skip in 3 existing tests). Model
  // identity therefore engages from the SECOND hop onward, once a swap target has
  // named a real tier — exactly the shape a claude -> native@fast -> native@balanced
  // chain produces.
  describe("runWithFallback (end to end)", () => {
    test("a fallback target resolving to the SAME model as the tier that just failed is excluded", async () => {
      stubSleep();
      const config = NaxConfigSchema.parse({
        agent: {
          protocol: "hybrid",
          default: "claude",
          fallback: {
            enabled: true,
            map: {
              claude: [
                { agent: "native", tier: "fast" },
                { agent: "native", tier: "balanced" },
              ],
            },
          },
        },
      });
      const manager = new AgentManager(config, undefined, { models: SAME_MODEL });

      const hops: { agent: string; hopKind: HopKind }[] = [];
      const outcome = await manager.runWithFallback({
        runOptions: makeRunOptions(config),
        executeHop: async (agent, bundle, hopKind) => {
          hops.push({ agent, hopKind });
          return {
            result: {
              success: false,
              exitCode: 1,
              output: "rate limited",
              rateLimited: true,
              durationMs: 0,
              estimatedCostUsd: 0,
              adapterFailure: RATE_LIMIT_FAILURE,
            },
            bundle,
          };
        },
      });

      // native@fast and native@balanced resolve to the SAME model — once native@fast
      // fails, native@balanced must never be offered as a fresh candidate. No hop ever
      // names "balanced" (after nextCandidate excludes it, the run backs off and retries
      // the SAME dead native@fast hop per defaultRetryStrategy before exhausting — hence
      // checking the whole sequence rather than an exact hop count).
      expect(hops[0]).toEqual({ agent: "claude", hopKind: { kind: "primary" } });
      expect(hops.slice(1).every((h) => h.agent === "native" && h.hopKind.tier === "fast")).toBe(true);
      expect(outcome.fallbacks).toHaveLength(1);
      expect(outcome.result.success).toBe(false);
    });

    test("a fallback target resolving to a DIFFERENT model still dispatches", async () => {
      stubSleep();
      const config = NaxConfigSchema.parse({
        agent: {
          protocol: "hybrid",
          default: "claude",
          fallback: {
            enabled: true,
            map: {
              claude: [
                { agent: "native", tier: "fast" },
                { agent: "native", tier: "balanced" },
              ],
            },
          },
        },
      });
      const manager = new AgentManager(config, undefined, { models: DIFFERENT_MODEL });

      const hops: { agent: string; hopKind: HopKind }[] = [];
      const outcome = await manager.runWithFallback({
        runOptions: makeRunOptions(config),
        executeHop: async (agent, bundle, hopKind) => {
          hops.push({ agent, hopKind });
          const result =
            hops.length <= 2
              ? {
                  success: false,
                  exitCode: 1,
                  output: "rate limited",
                  rateLimited: true,
                  durationMs: 0,
                  estimatedCostUsd: 0,
                  adapterFailure: RATE_LIMIT_FAILURE,
                }
              : { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 };
          return { result, bundle };
        },
      });

      expect(hops).toEqual([
        { agent: "claude", hopKind: { kind: "primary" } },
        { agent: "native", hopKind: { kind: "swap", failure: RATE_LIMIT_FAILURE, tier: "fast" } },
        { agent: "native", hopKind: { kind: "swap", failure: RATE_LIMIT_FAILURE, tier: "balanced" } },
      ]);
      expect(outcome.result.success).toBe(true);
    });
  });
});

const NATIVE_MODELS = {
  native: {
    balanced: "minimax/MiniMax-M3",
    powerful: "opencode-go/deepseek-v4-flash",
    glm: "openrouter/z-ai/glm-5.3-flash[high]",
  },
};

function managerWithModels(map: Record<string, unknown[]>) {
  const config = NaxConfigSchema.parse({
    agent: { protocol: "hybrid", default: "native", fallback: { enabled: true, map, maxHopsPerStory: 3 } },
    models: NATIVE_MODELS,
  });
  return new AgentManager(config, undefined, { models: NATIVE_MODELS });
}

const RL: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "rate limited",
};

describe("literal-pin fallback targets (nax#1966)", () => {
  test("a literal-pin rung survives the primary agent's cooldown", () => {
    const m = managerWithModels({
      native: [
        { agent: "native", model: "powerful" },
        { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" },
        "claude",
      ],
    });

    // The primary hop failed at its dispatched tier, as runWithFallback now records it.
    m.markUnavailable("native", RL, "balanced");
    // Then rung 1 failed too.
    m.markUnavailable("native", RL, "powerful");

    // `hops` is the caller's current ladder depth (nax#1965) — after the one real
    // swap so far (primary -> rung 1), that is 1, not the story's hop cap. A
    // stale/arbitrary value here would silently mask `nextLadderCandidate`'s
    // depth filter (ladder-slot.ts), which requires a candidate strictly deeper
    // than `hops` to be offered.
    expect(m.nextCandidate("native", 1, "native", "powerful")).toEqual({
      agent: "native",
      model: "openrouter/z-ai/glm-5.3-flash[high]",
    });
  });

  test("a literal pin and the tier naming the same model share one identity", () => {
    // The strings must match byte for byte, effort suffix included — that is what makes
    // both spellings resolve through resolveModel to the same ModelDef.
    const m = managerWithModels({
      native: [{ agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" }, "claude"],
    });

    m.markUnavailable("native", RL, "glm");

    expect(m.nextCandidate("native", 1, "native", "glm")).toEqual({ agent: "claude" });
  });
});
