import { describe, expect, test } from "bun:test";
import { resolveFinalDispatch } from "@/agents/manager-dispatch";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import type { ResolvedCompleteOptions } from "@/agents/types";

describe("resolveFinalDispatch", () => {
  const base: ResolvedCompleteOptions = {
    modelDef: { provider: "anthropic", model: "primary-model" },
    modelDefFor: (agent: string, tier?: string) => ({ provider: "p", model: `${agent}:${tier ?? "default"}` }),
    modelTier: "balanced",
    workdir: "/tmp",
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
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
    // Without threading finalTier this is "native:default" — a model that never ran, billed against the run.
    const out = resolveFinalDispatch(base, "claude", { fallbacks: swapped, finalTier: "cheap" });
    expect(out.options.modelDef.model).toBe("native:cheap");
  });

  test("a tier-carrying swap also records that tier, so model and modelTier agree", () => {
    const out = resolveFinalDispatch(base, "claude", { fallbacks: swapped, finalTier: "cheap" }).options;
    expect(out.modelDef.model).toBe("native:cheap");
    expect(out.modelTier).toBe("cheap");
  });

  test("no tier means today's behaviour", () => {
    expect(resolveFinalDispatch(base, "claude", { fallbacks: swapped }).options.modelDef.model).toBe("native:default");
  });

  test("no tier leaves modelTier as the base had it", () => {
    expect(resolveFinalDispatch(base, "claude", { fallbacks: swapped }).options.modelTier).toBe("balanced");
  });

  test("a literal model pin on the final target is the model the cost row records", () => {
    const out = resolveFinalDispatch(base, "claude", {
      fallbacks: swapped,
      finalTarget: { agent: "native", model: "pinned-literal-model" },
    });
    expect(out.agentName).toBe("native");
    expect(out.options.modelDef.model).toBe("pinned-literal-model");
  });
});
