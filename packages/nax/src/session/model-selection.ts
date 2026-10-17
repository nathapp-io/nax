/**
 * Model-selection fields forwarded from an `OpenSessionRequest` to the adapter.
 *
 * Its own module because `manager.ts` is a grandfathered oversized file that may
 * not grow, and the alternative home is a worse fit: `manager-deps.ts` is the
 * injectable-dependency facade.
 */

import type { SessionModel } from "@nathapp/nax-agent";
import { toSessionModel } from "../agents/session-model-mapping";
import { type CodexAcpSettings, withCodexAcpEnv } from "../agents/shared/codex-acp-env";
import type { ModelDef, ModelTier } from "../config/schema";

/**
 * Re-exported for `SessionManager.openSession`, which needs the codex settings
 * alongside the model selection they parameterise. That file sits at its
 * 650-line grandfathered ceiling and cannot take a second import statement, so
 * both symbols travel on the import it already has from this module.
 */
export { codexAcpSettings } from "../agents/shared/codex-acp-env";

export interface ModelSelection {
  modelDef: ModelDef;
  modelTier?: ModelTier;
  /**
   * Agent the model is being selected for. Optional because the two-argument
   * `selectModel` form is the only caller that needs it — codex's env injection
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
 * `codex`, when supplied, is the resolved `agent.acp.codex` block: the config
 * def first passes through `withCodexAcpEnv`, so a codex session opens with its
 * `INITIAL_AGENT_MODE` (and optionally an isolated `CODEX_HOME`). Called with
 * one argument this behaves exactly as before (US-002).
 */
export function selectModel(
  opts: ModelSelection,
  codex?: CodexAcpSettings,
): { modelDef: SessionModel; modelTier?: string } {
  const modelDef = codex === undefined ? opts.modelDef : withCodexAcpEnv(opts.modelDef, opts.agentName, codex);
  return { modelDef: toSessionModel(modelDef), ...(opts.modelTier ? { modelTier: opts.modelTier } : {}) };
}
