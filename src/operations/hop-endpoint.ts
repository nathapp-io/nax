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

/** The tier a hop dispatches at: the one it named, else the caller's effective tier. */
export function hopTier(hopKind: HopKind, effectiveTier: string): string {
  return "tier" in hopKind ? (hopKind.tier ?? effectiveTier) : effectiveTier;
}

/** A hop's LITERAL model pin, when it carries one. Mutually exclusive with `tier`. */
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
