/**
 * The composed ACP launch env (US-002, opencode-acp-read-only).
 *
 * Every ACP agent that needs a launch-time variable set has its own module
 * (`codex-acp-env.ts`, `opencode-acp-env.ts`), because each one's settings,
 * defaults and failure mode are its own. This module is the single seam that
 * reads all of them and applies them in one call.
 *
 * It exists so a caller cannot pick up one agent's variable set and silently
 * drop another's: `selectModel` and `completeAsWithFallback` used to take the
 * codex settings directly, and a second agent's injection added beside them
 * would have to be remembered at each call site. Here the callers pass one
 * settings object and get one def back.
 *
 * Composition order (codex, then opencode) is fixed in `withAcpEnv` only. The
 * two injections are independent in both directions: each one returns the def
 * untouched for the other's agent name, so no ordering hazard exists, but the
 * order is still written down once rather than left to each caller.
 */

import type { NaxConfig } from "@/config";
import { type CodexAcpSettings, codexAcpSettings, withCodexAcpEnv } from "./codex-acp-env";
import { type OpencodeAcpSettings, opencodeAcpSettings, withOpencodeAcpEnv } from "./opencode-acp-env";

export interface AcpEnvSettings {
  readonly codex: CodexAcpSettings;
  readonly opencode: OpencodeAcpSettings;
}

/** Settings from config.agent.acp, one entry per agent that injects env. */
export function acpEnvSettings(config: Pick<NaxConfig, "agent"> | undefined): AcpEnvSettings {
  return { codex: codexAcpSettings(config), opencode: opencodeAcpSettings(config) };
}

/**
 * The model def an ACP agent call starts with: every agent's launch env applied
 * to it in turn. A NEW def when anything was injected, the input itself when
 * nothing applies (see each agent's `with*AcpEnv`).
 */
export function withAcpEnv<T extends { env?: Record<string, string> }>(
  def: T,
  agentName: string | undefined,
  settings: AcpEnvSettings,
): T {
  return withOpencodeAcpEnv(withCodexAcpEnv(def, agentName, settings.codex), agentName, settings.opencode);
}
