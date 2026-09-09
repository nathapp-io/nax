/**
 * Fallback targets spelled the ConfiguredModel way: `{ agent, model }`.
 *
 * Split out of fallback-tier-targets.test.ts (800-line test limit). That file
 * owns the `{ agent, tier }` spelling and the identity split it forced; this one
 * owns the `.model` spelling — a LITERAL pin reaching dispatch, parity between
 * the two spellings of one target, and the cooldown SCOPE the policy table
 * assigns each failure outcome.
 */

import { describe, expect, test } from "bun:test";
import { AgentManager } from "@/agents/manager";
import type { HopKind } from "@/agents/manager-types";
import { NaxConfigSchema } from "@/config/schemas";
import type { AdapterFailure } from "@/context/engine";

describe("a literal model pin as a fallback target (claude -> {agent: native, model: openrouter/...})", () => {
  // `{ agent, model }` follows ConfiguredModel: `model` may name a tier OR a literal
  // model id. A tier-naming target is converted to `{ agent, tier }` before dispatch;
  // a LITERAL id has no tier to convert to, and the dispatch seam understood only
  // tiers — so the pin was accepted and selected, then dispatched at the caller's own
  // effective tier. The operator asks for one provider and silently gets another.
  const PIN = "openrouter/z-ai/glm-5.3-flash[high]";
  const RATE_LIMIT_FAILURE: AdapterFailure = {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: "rate limited",
  };

  function pinConfig() {
    return NaxConfigSchema.parse({
      agent: {
        protocol: "hybrid",
        default: "claude",
        fallback: { enabled: true, map: { claude: [{ agent: "native", model: PIN }] } },
      },
      models: { claude: { balanced: "claude-sonnet-4-5" }, native: { cheap: "opencode-go/glm-4-5" } },
    });
  }

  test("nextCandidate keeps the literal pin instead of degrading it to a tier", () => {
    const config = pinConfig();
    const manager = new AgentManager(config, undefined, { models: config.models });

    expect(manager.nextCandidate("claude", 0, "claude")).toEqual({ agent: "native", model: PIN });
  });

  test("the swap hop carries the literal pin so the hop dispatches at that model", async () => {
    const config = pinConfig();
    const manager = new AgentManager(config, undefined, { models: config.models });
    const hops: { agent: string; hopKind: HopKind }[] = [];

    const outcome = await manager.runWithFallback({
      runOptions: {
        prompt: "do it",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
        timeoutSeconds: 60,
        config,
      },
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
      { agent: "claude", hopKind: { kind: "primary" } },
      { agent: "native", hopKind: { kind: "swap", failure: RATE_LIMIT_FAILURE, model: PIN } },
    ]);
  });
});

describe("review follow-ups: spelling parity and agent-wide cooldown scope", () => {
  const AUTH_FAILURE: AdapterFailure = {
    category: "availability",
    outcome: "fail-auth",
    retriable: false,
    message: "401",
  };
  const RATE_LIMIT: AdapterFailure = {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: "429",
  };
  const MODELS = {
    native: { fast: "minimax/MiniMax-M2.7", powerful: "opencode-go/deepseek-v4-flash[high]" },
    claude: { fast: "haiku", balanced: "sonnet[medium]" },
  };

  function manager(map: Record<string, unknown[]>) {
    const config = NaxConfigSchema.parse({
      agent: { protocol: "hybrid", default: "native", fallback: { enabled: true, map } },
      models: MODELS,
    });
    return new AgentManager(config, undefined, { models: config.models });
  }

  // `{ agent, model }` naming a tier and `{ agent, tier }` naming the same tier are
  // the same target written two ways — ConfiguredModel parity is the whole point of
  // the `.model` spelling. They diverged because availableCandidates filtered on
  // `candidate.tier`, which a `.model` target does not carry until
  // resolveFallbackDispatchTarget folds it in — and that ran AFTER the filter.
  test("a `.model` target naming a tier is selected exactly like the `.tier` spelling", () => {
    const asTier = manager({ native: [{ agent: "native", tier: "powerful" }] }).nextCandidate("native", 0, "native");
    const asModel = manager({ native: [{ agent: "native", model: "powerful" }] }).nextCandidate("native", 0, "native");

    expect(asModel).toEqual({ agent: "native", tier: "powerful" });
    expect(asModel).toEqual(asTier);
  });

  // fail-auth is a CREDENTIALS failure: it belongs to the agent, not to one model,
  // and its policy cooldown is "run". Scoping it to the failing tier's model left
  // every other tier of the same agent looking healthy, so the swap re-dispatched
  // to the same broken credentials and burned a hop to learn nothing.
  test("an agent-wide failure (fail-auth) cools every tier of that agent", () => {
    const m = manager({ claude: [{ agent: "claude", tier: "balanced" }] });

    m.markUnavailable("claude", AUTH_FAILURE, "fast");

    expect(m.isUnavailable("claude", "balanced")).toBe(true);
    expect(m.nextCandidate("claude", 0, "claude", "fast")).toBeNull();
  });

  // The converse must still hold, or the first fix is undone: a rate limit is
  // model-scoped, so a different tier on a different provider stays selectable.
  test("a model-scoped failure (fail-rate-limit) still leaves other tiers selectable", () => {
    const m = manager({ native: [{ agent: "native", tier: "powerful" }] });

    m.markUnavailable("native", RATE_LIMIT, "fast");

    expect(m.nextCandidate("native", 0, "native", "fast")).toEqual({ agent: "native", tier: "powerful" });
  });
});
