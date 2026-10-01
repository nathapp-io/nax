/**
 * Model-selection fields forwarded from an `OpenSessionRequest` to the adapter.
 *
 * Its own module because `manager.ts` is a grandfathered oversized file that may
 * not grow, and the alternative home is a worse fit: `manager-deps.ts` is the
 * injectable-dependency facade.
 */

import { toSessionModel } from "../agents/session-model-mapping";
import type { SessionModel } from "../agents/session-types";
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
 *
 * The `ModelDef` becomes the contract's `SessionModel` here; this is where
 * config pricing is converted for session opens.
 */
export function selectModel(opts: ModelSelection): { modelDef: SessionModel; modelTier?: string } {
  return { modelDef: toSessionModel(opts.modelDef), ...(opts.modelTier ? { modelTier: opts.modelTier } : {}) };
}
