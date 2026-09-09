/**
 * Whether a prompt carries the pull-tool catalogue as text.
 *
 * Under ACP the prompt is the only channel for tools, so the catalogue is
 * rendered into it. The native path sends the same tools as structured
 * ToolDefinitions; injecting both describes them twice in two protocols and
 * invites a reply in the text form, which the native path never parses — so the
 * call would be silently lost (ADR-028 section 7).
 *
 * Lives beside both transports rather than inside either: it is a dispatch
 * question, and putting it under native/ would mean importing ACP into the
 * native tree. Imports are relative because `@/agents/acp/adapter-output` is an
 * internal file and `check:alias-internals` requires aliases to name barrels —
 * the same idiom session-run-hop.ts and build-hop-callback.ts already use.
 *
 * One helper rather than a condition at each call site: the two sites must not
 * drift, and a third would otherwise be written without the guard.
 */

import { applyProtocolRegions } from "../prompts/sections";
import { buildContextToolPreamble } from "./acp/adapter-output";
import { NATIVE_AGENT } from "./native/models";
import type { AgentRunOptions } from "./types";

export function promptWithToolPreamble(agentName: string, options: AgentRunOptions): string {
  if (agentName === NATIVE_AGENT) return options.prompt;
  return buildContextToolPreamble(options);
}

/**
 * Substitute every protocol-region marker for the protocol being dispatched.
 *
 * Sits beside the tool-preamble branch for the same reason it does: this is a
 * dispatch question, decided after any fallback swap, and the builders that
 * emit the regions cannot know which protocol will receive their text
 * (`operations/call.ts:55` joins the prompt; `:69` resolves the agent).
 *
 * Unlike the preamble this runs unconditionally on both protocols — ACP needs
 * the markers stripped even though it keeps the body, so an agent never sees
 * one. Its two call sites must not drift, which is why it is a helper here
 * rather than a condition written out at each.
 *
 * US-003 — the registered kinds are `diff-access`, `run-check` and `run-test`
 * (US-005 will add `commit`). Each kind carries its own `requires` list and
 * native renderer; `applyProtocolRegions` substitutes every region in one
 * pass and gates each on its `requires` set. The legacy `applyDiffAccess`
 * entry point is retained for its existing test suite as a thin adapter,
 * but the dispatch seam routes through the SSOT so a new kind added to the
 * registry is substituted without further dispatch changes.
 *
 * Named for the protocol, not the agent: the agent name is only how the
 * protocol is derived. Every ACP agent gets the same rendering, so nothing here
 * varies with agent identity, and a future transport would extend the protocol
 * branch rather than add an agent to a list.
 *
 * `advertisedTools` (US-002) — required third parameter. A caller that cannot
 * know the advertised tool set must explicitly say so; a future third
 * dispatch site that omits the parameter fails at the type seam rather than
 * silently ungating native rendering.
 */
export function applyDiffAccessForAgentProtocol(
  agentName: string,
  prompt: string,
  advertisedTools: readonly string[],
): string {
  return applyProtocolRegions(prompt, {
    protocol: agentName === NATIVE_AGENT ? "native" : "acp",
    advertisedTools: new Set(advertisedTools),
  });
}
