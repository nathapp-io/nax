/**
 * Model-selection fields forwarded from an `OpenSessionRequest` to the adapter.
 *
 * Its own module because `manager.ts` is a grandfathered oversized file that may
 * not grow, and the alternative home is a worse fit: `manager-deps.ts` is the
 * injectable-dependency facade.
 */

import type { SessionModel } from "@nathapp/nax-agent";
import { toSessionModel } from "../agents/session-model-mapping";
import { type AcpEnvSettings, withAcpEnv } from "../agents/shared/acp-env";
import type { ModelDef, ModelTier } from "../config/schema";

/**
 * Re-exported for `SessionManager.openSession`, which needs the ACP env settings
 * alongside the model selection they parameterise. That file sits at its
 * 650-line grandfathered ceiling and cannot take a second import statement, so
 * both symbols travel on the import it already has from this module.
 */
export { acpEnvSettings } from "../agents/shared/acp-env";

export interface ModelSelection {
  modelDef: ModelDef;
  modelTier?: ModelTier;
  /**
   * Agent the model is being selected for. Optional because the two-argument
   * `selectModel` form is the only caller that needs it — every ACP launch env
   * is keyed on the agent name (US-002).
   */
  agentName?: string;
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
 *
 * `acp`, when supplied, is the resolved `agent.acp` block: the config def first
 * passes through `withAcpEnv`, so a session opens with every ACP agent's launch
 * env applied (codex's `INITIAL_AGENT_MODE` and optionally an isolated
 * `CODEX_HOME`; opencode's `OPENCODE_CONFIG_DIR` when isolated). Called with one
 * argument this behaves exactly as before (US-002).
 */
export function selectModel(
  opts: ModelSelection,
  acp?: AcpEnvSettings,
): { modelDef: SessionModel; modelTier?: string } {
  const modelDef = acp === undefined ? opts.modelDef : withAcpEnv(opts.modelDef, opts.agentName, acp);
  return { modelDef: toSessionModel(modelDef), ...(opts.modelTier ? { modelTier: opts.modelTier } : {}) };
}
