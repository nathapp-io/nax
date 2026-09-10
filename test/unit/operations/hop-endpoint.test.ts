import { describe, expect, test } from "bun:test";
import type { ModelsConfig } from "@/config/schema-types";
import type { AdapterFailure } from "@/context/engine";
import { resolveHopEndpoint } from "@/operations/hop-endpoint";

const MODELS: ModelsConfig = {
  native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" },
};

const FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "429",
};

const base = {
  models: MODELS,
  agentName: "native",
  effectiveTier: "balanced",
  defaultAgent: "native",
};

describe("resolveHopEndpoint()", () => {
  test("a caller-pinned primary keeps the pin and reports no tier", () => {
    const pin = { provider: "minimax", model: "minimax/MiniMax-M3" };
    const out = resolveHopEndpoint({ ...base, hopKind: { kind: "primary" }, pinnedModelDef: pin });
    expect(out.modelDef).toBe(pin);
    expect(out.modelTier).toBeUndefined();
  });

  test("a swap hop ignores the caller's pin and resolves its own tier", () => {
    const pin = { provider: "minimax", model: "minimax/MiniMax-M3" };
    const out = resolveHopEndpoint({
      ...base,
      hopKind: { kind: "swap", failure: FAILURE, tier: "powerful" },
      pinnedModelDef: pin,
    });
    expect(out.modelDef.model).toBe("opencode-go/deepseek-v4-flash[high]");
    expect(out.modelTier).toBe("powerful");
  });

  test("a swap hop with a literal pin resolves that id and reports no tier", () => {
    const out = resolveHopEndpoint({
      ...base,
      hopKind: { kind: "swap", failure: FAILURE, model: "openrouter/z-ai/glm-5.3-flash[high]" },
      pinnedModelDef: undefined,
    });
    expect(out.modelDef.model).toBe("openrouter/z-ai/glm-5.3-flash[high]");
    expect(out.modelTier).toBeUndefined();
  });

  test("a stale-retry keeps the caller's pin — it is the same session's model", () => {
    const pin = { provider: "minimax", model: "minimax/MiniMax-M3" };
    const out = resolveHopEndpoint({
      ...base,
      hopKind: { kind: "stale-retry", attempt: 1 },
      pinnedModelDef: pin,
    });
    expect(out.modelDef).toBe(pin);
  });

  test("an unpinned primary resolves the effective tier and reports it", () => {
    const out = resolveHopEndpoint({ ...base, hopKind: { kind: "primary" }, pinnedModelDef: undefined });
    expect(out.modelDef.model).toBe("minimax/MiniMax-M3");
    expect(out.modelTier).toBe("balanced");
  });
});
