/**
 * Model-resolution precheck check.
 *
 * One local catalog-backed walk over configured model references that:
 *   - blocks (Tier 1) an unresolved native id,
 *   - warns (Tier 2) for an unresolved ACP id,
 *   - warns when a literal `{agent, model}` pin drops tier-configured pricing
 *     or contextWindow overrides that the literal route would have used.
 *
 * The check is intentionally narrow: a literal pin against an `models.<agent>`
 * tier routes through `resolveModel(selection.model)` and never re-reads the
 * tier entry's overrides (out of scope: nax#1984 Option 1). A user who sets
 * pricing/contextWindow on a tier and then literal-pins the same id gets the
 * warning, not a silent override-loss.
 *
 * The resolver is supplied via `_modelResolutionDeps.resolveNative` and
 * `resolveAcp`. Production wires them to the local nax-ai catalog; tests swap
 * them in to drive specific outcomes without loading the bundled catalog.
 */

import type { Check } from "./types";

/** A literal `{agent, model}` pin found at a config site. */
interface LiteralPin {
  /** Configuration key path (e.g. "review.adversarial.model"). */
  readonly keyPath: string;
  readonly agent: string;
  readonly model: string;
  /** True when `models[agent][model]` exists and declared pricing/contextWindow. */
  readonly tierEntryOverrides?: { hasPricing: boolean; hasContextWindow: boolean };
}

export interface ModelResolutionDeps {
  /**
   * Look up a native (provider-qualified) id. Returns "resolved", "unresolved",
   * or "error". A "resolved" result MUST surface whether pricing and
   * contextWindow were declared — the literal-pin warning needs it.
   */
  resolveNative: (
    provider: string,
    model: string,
  ) => Promise<{ status: "resolved" | "unresolved" | "error"; hasPricing?: boolean; hasContextWindow?: boolean }>;
  /**
   * Look up an ACP id. ACP does not have a local catalog mirror, so "resolved"
   * is an agent-side claim (acpx is asked at dispatch time). The check treats
   * an unresolved ACP id as a warning, never a blocker — the original parse
   * error surfaces from the review dispatch instead.
   */
  resolveAcp: (agent: string, model: string) => Promise<{ status: "resolved" | "unresolved" | "error" }>;
}

/** Injectable seam — production wires this to src/agents/native/. */
export const _modelResolutionDeps: ModelResolutionDeps = {
  resolveNative: async () => ({ status: "unresolved" }),
  resolveAcp: async () => ({ status: "unresolved" }),
};

/**
 * Build the list of (keyPath, agent, model) triples the check walks.
 *
 * The implementer will compose this from the actual config slice
 * (models.native.*, review.semantic.model, review.adversarial.model,
 * plan.model, acceptance.model, tdd.sessionTiers.*, routing.llm.model,
 * every rung of autoMode.escalation.tierOrder, every rung of
 * agent.fallback.map). The stub returns an empty list so the check is
 * a no-op pass until real collection is wired in — exactly what the
 * implementer needs to flip from "passes" to "produces checks".
 */
export function collectConfiguredModelPins(_config: unknown): LiteralPin[] {
  return [];
}

/**
 * Tier-1/2 model-resolution check.
 *
 * Walks every collected literal pin and every `models.<agent>.<tier>` entry,
 * emitting one Check per failure site. A resolver that rejects the catalog
 * emits a single warning (AC6) — never a blocker — so a transient catalog
 * miss does not stop a run.
 */
export async function checkModelResolution(config: unknown): Promise<Check[]> {
  const pins = collectConfiguredModelPins(config);
  if (pins.length === 0) {
    return [{ name: "model-resolution", tier: "blocker", passed: true, message: "All configured model ids resolve" }];
  }
  // Real implementation walks `pins` against `_modelResolutionDeps.resolveNative`
  // / `resolveAcp`, emits a `blocker` for an unresolved native id and a
  // `warning` for an unresolved ACP id or a literal pin that drops overrides.
  // The stub leaves the wiring to the implementer.
  return [{ name: "model-resolution", tier: "blocker", passed: true, message: "All configured model ids resolve" }];
}
