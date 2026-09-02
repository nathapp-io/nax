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

import { buildContextToolPreamble } from "./acp/adapter-output";
import { NATIVE_AGENT } from "./native/models";
import type { AgentRunOptions } from "./types";

export function promptWithToolPreamble(agentName: string, options: AgentRunOptions): string {
  if (agentName === NATIVE_AGENT) return options.prompt;
  return buildContextToolPreamble(options);
}
