/**
 * Per-agent ACP launch settings whose schema and default constant live outside
 * `schemas-infra.ts`.
 *
 * `schemas-infra.ts` is at its 600-line ceiling, so a new agent block that needs
 * its own stable default constant (imported by the agent's env module, the inner
 * schema default and both literal `agent.acp` defaults, so the three can never
 * disagree) is declared here and composed into `AgentAcpConfigSchema`. The shape
 * is deliberately identical to the codex and opencode blocks beside it.
 */

import { z } from "zod";

/** Stable default for `agent.acp.gemini` (US-002, gemini-acp-read-only) —
 *  asserted in `schemas-infra.ts`, in `schemas.ts`'s literal default and in
 *  `geminiAcpSettings`, for the same reason as `DEFAULT_AGENT_CODEX_ACP_CONFIG`. */
export const DEFAULT_AGENT_GEMINI_ACP_CONFIG: {
  isolateHome: boolean;
} = {
  isolateHome: false,
};

/**
 * gemini-only launch settings (US-002, gemini-acp-read-only). `isolateHome`
 * points `GEMINI_CLI_HOME` at a nax-owned home that links only the operator's
 * credential files and carries only `security.auth.selectedType` — so the
 * operator's own gemini home (saved "Always Allow" approvals, user policies,
 * installed extensions, MCP servers) stays out of a nax session. Off by
 * default: an isolated home is a narrower session than the operator's.
 */
export const AgentGeminiAcpConfigSchema = z
  .object({
    isolateHome: z.boolean().default(false),
  })
  .default({ ...DEFAULT_AGENT_GEMINI_ACP_CONFIG });
