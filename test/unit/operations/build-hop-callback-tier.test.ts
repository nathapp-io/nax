/**
 * The run path applies a swapped hop's tier.
 *
 * Separate from the complete path because the two resolve their model in
 * different places: the complete path re-resolves inside the manager via
 * modelDefFor, while the run path resolves here, in the caller. Covering only
 * one leaves { agent, tier } working for complete ops and silently ignored for
 * run ops.
 */

import { describe, expect, test } from "bun:test";
import { resolveModel, resolveModelForAgent } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import { hopModelId, hopTier } from "@/operations/build-hop-callback";

const SWAP_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-auth",
  retriable: false,
  message: "401",
};

describe("hopTier", () => {
  test("a primary hop uses the caller's effective tier", () => {
    expect(hopTier({ kind: "primary" }, "balanced")).toBe("balanced");
  });

  test("a start-on-fallback primary hop that named a tier uses it", () => {
    expect(hopTier({ kind: "primary", tier: "cheap" }, "balanced")).toBe("cheap");
  });

  test("a swap with no tier uses the caller's effective tier", () => {
    expect(hopTier({ kind: "swap", failure: SWAP_FAILURE }, "balanced")).toBe("balanced");
  });

  test("a swap that named a tier uses it", () => {
    expect(hopTier({ kind: "swap", failure: SWAP_FAILURE, tier: "cheap" }, "balanced")).toBe("cheap");
  });

  test("a tierless pinned resolution swaps onto the target's balanced rung (spec §7 last resort)", () => {
    // hop ctx with effectiveTier "balanced" (the call.ts:69 default for a pin, modelTier absent),
    // swap to an agent with a balanced entry, no fallback-map tier for the candidate.
    // Assert the dispatched modelDef is the swap target's balanced entry.
    const tier = hopTier({ kind: "swap", failure: SWAP_FAILURE }, "balanced");
    expect(tier).toBe("balanced");
    const modelDef = resolveModelForAgent(
      {
        claude: { balanced: "claude-sonnet-4-5", powerful: "claude-opus-4-5" },
        native: { cheap: "opencode-go/glm-4-5" },
      },
      "claude",
      tier,
      "claude",
    );
    expect(modelDef.model).toBe("claude-sonnet-4-5");
  });

  test("a timeout retry retains its fallback target's tier", () => {
    expect(hopTier({ kind: "timeout-retry", attempt: 1, tier: "cheap" }, "balanced")).toBe("cheap");
  });

  test("a stale-retry uses the caller's effective tier", () => {
    expect(hopTier({ kind: "stale-retry", attempt: 1 }, "balanced")).toBe("balanced");
  });
});

/**
 * The run path applies a swapped hop's literal model pin.
 *
 * `{ agent, model }` may name a tier OR a literal model id (ConfiguredModel
 * semantics). A tier-naming target is resolved to `{ agent, tier }` before it
 * reaches here, so only a LITERAL pin arrives with `model` set — and the tier
 * lookup cannot serve it: there is no tier key to look up. Without this the
 * pin is accepted, selected, and then silently dispatched at the caller's own
 * effective tier — the operator asks for one provider and gets another.
 */
describe("hopModelId", () => {
  test("a primary hop names no literal model", () => {
    expect(hopModelId({ kind: "primary" })).toBeUndefined();
  });

  test("a swap that named a tier names no literal model", () => {
    expect(hopModelId({ kind: "swap", failure: SWAP_FAILURE, tier: "cheap" })).toBeUndefined();
  });

  test("a swap that named a literal model returns it", () => {
    expect(hopModelId({ kind: "swap", failure: SWAP_FAILURE, model: "openrouter/z-ai/glm-5.3-flash[high]" })).toBe(
      "openrouter/z-ai/glm-5.3-flash[high]",
    );
  });

  test("a start-on-fallback primary hop that named a literal model returns it", () => {
    expect(hopModelId({ kind: "primary", model: "openrouter/z-ai/glm-5.3-flash[high]" })).toBe(
      "openrouter/z-ai/glm-5.3-flash[high]",
    );
  });

  test("a timeout retry retains its fallback target's literal model", () => {
    expect(hopModelId({ kind: "timeout-retry", attempt: 1, model: "openrouter/z-ai/glm-5.3-flash[high]" })).toBe(
      "openrouter/z-ai/glm-5.3-flash[high]",
    );
  });

  test("the literal pin resolves to the same ModelDef the tier map would produce for that id", () => {
    // The dispatched def must be indistinguishable from writing the same id as a
    // `models.native.<tier>` entry — that equivalence is the whole contract of a
    // literal pin, and on the native path the provider is read from the id string
    // (nax#1851), not from ModelDef.provider.
    const id = "openrouter/z-ai/glm-5.3-flash[high]";
    expect(resolveModel(id)).toEqual(resolveModelForAgent({ native: { glm: id } }, "native", "glm", "native"));
  });
});
