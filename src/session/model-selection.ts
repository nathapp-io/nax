/**
 * Model-selection fields forwarded from an `OpenSessionRequest` to the adapter.
 *
 * Its own module because `manager.ts` is a grandfathered oversized file that may
 * not grow, and the alternative homes are worse fits: `manager-run.ts` is the
 * tracked-session lifecycle and `manager-deps.ts` is the injectable-dependency
 * facade.
 */

import type { ModelDef, ModelTier } from "../config/schema";

export interface ModelSelection {
  modelDef: ModelDef;
  modelTier?: ModelTier;
}

/**
 * Narrow an open-session request to just its model selection.
 *
 * `modelTier` is omitted rather than passed as `undefined` when absent: an
 * explicit `{ agent, model }` pin bypasses tier resolution, so reporting a tier
 * there would claim one that never selected the model. Cost rows read this to
 * attribute spend to a tier (#1433).
 */
export function selectModel(opts: ModelSelection): ModelSelection {
  return { modelDef: opts.modelDef, ...(opts.modelTier ? { modelTier: opts.modelTier } : {}) };
}
