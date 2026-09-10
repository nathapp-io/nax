/**
 * The endpoint one hop dispatches to, and the tier (if any) that selected it.
 *
 * Extracted from build-hop-callback.ts, which is at the 600-line hard limit. It is
 * also the seam nax#1965 needed: the value returned here is what the hop REPORTS
 * back, so cooldown marking and candidate exclusion key on the endpoint that
 * actually dispatched rather than on whatever tier the HopKind happened to declare
 * (a config-default primary declares none).
 */

import { resolveModel, resolveModelForAgent } from "@/config";
import type { ModelDef, ModelsConfig } from "@/config/schema-types";
import type { HopKind } from "../agents/manager-types";

/**
 * The tier a hop should resolve its model at.
 *
 * Only a swap, or a start-on-fallback that named one, can carry a tier.
 * Everything else is the caller's effective tier, which is what every hop did
 * before tier-aware targets existed.
 */
export function hopTier(hopKind: HopKind, effectiveTier: string): string {
  return "tier" in hopKind ? (hopKind.tier ?? effectiveTier) : effectiveTier;
}

/**
 * The literal model id a hop was pinned to, if any.
 *
 * Set only by a fallback target spelled `{ agent, model }` whose model names no
 * tier (ConfiguredModel semantics — a tier-naming one is converted to a tier
 * before it reaches here). The tier map cannot serve such a pin: there is no
 * tier key to look up. Without this the pin was accepted, selected, and then
 * dispatched at the caller's own effective tier — the operator asks for one
 * provider and silently gets another.
 */
export function hopModelId(hopKind: HopKind): string | undefined {
  return "model" in hopKind ? hopKind.model : undefined;
}

export interface HopEndpoint {
  readonly modelDef: ModelDef;
  /** Only when a tier selected the model. A pin of either kind reports none (#1433). */
  readonly modelTier?: string;
}

export interface HopEndpointArgs {
  readonly hopKind: HopKind;
  /** The caller's pinned model, already narrowed to this agent (nax#1722). */
  readonly pinnedModelDef: ModelDef | undefined;
  readonly models: ModelsConfig;
  readonly agentName: string;
  readonly effectiveTier: string;
  readonly defaultAgent: string;
}

/**
 * A caller pin wins on a `primary` hop (it is what the caller asked for) and on a
 * `stale-retry` (same session, same model — the retry must not change endpoints).
 * A `swap` or `timeout-retry` has chosen its own target, so the pin is dropped.
 *
 * Rule: a caller pin wins ONLY for `primary`/`stale-retry`. Any pin that ends up
 * selecting the model — the caller's, or a hop-level literal `model` — reports no
 * `modelTier`, because no tier selected it (#1433). This deliberately diverges from
 * the pre-extraction code, which reported `modelTier` for a hop-level literal pin
 * on `swap`/`timeout-retry` even though the tier map played no part in resolving
 * `modelDef` there — see the regression tests below.
 */
function pinWins(kind: HopKind["kind"]): boolean {
  return kind === "primary" || kind === "stale-retry";
}

export function resolveHopEndpoint(args: HopEndpointArgs): HopEndpoint {
  const { hopKind, pinnedModelDef, models, agentName, effectiveTier, defaultAgent } = args;
  if (pinnedModelDef !== undefined && pinWins(hopKind.kind)) return { modelDef: pinnedModelDef };

  const pin = hopModelId(hopKind);
  if (pin) return { modelDef: resolveModel(pin) };

  const tier = hopTier(hopKind, effectiveTier);
  return { modelDef: resolveModelForAgent(models, agentName, tier, defaultAgent), modelTier: tier };
}
