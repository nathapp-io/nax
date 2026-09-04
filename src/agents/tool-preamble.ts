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

import { applyDiffAccess } from "../prompts/diff-access";
import { buildContextToolPreamble } from "./acp/adapter-output";
import { NATIVE_AGENT } from "./native/models";
import type { AgentRunOptions } from "./types";

export function promptWithToolPreamble(agentName: string, options: AgentRunOptions): string {
  if (agentName === NATIVE_AGENT) return options.prompt;
  return buildContextToolPreamble(options);
}

/**
 * Render every diff-access region for the protocol actually being dispatched.
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
 */
export function applyDiffAccessForAgent(agentName: string, prompt: string): string {
  return applyDiffAccess(prompt, agentName === NATIVE_AGENT ? "native" : "acp");
}
