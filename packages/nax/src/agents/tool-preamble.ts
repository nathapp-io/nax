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
 * native tree. The text-protocol catalogue renderer (`buildContextToolPreamble`)
 * lives here, beside its only production caller; it moved out of agents/acp/
 * in S4b-1.
 *
 * One helper rather than a condition at each call site: the two sites must not
 * drift, and a third would otherwise be written without the guard.
 */

import { NATIVE_AGENT } from "@nathapp/nax-agent/internal";
import type { ToolDescriptor } from "@/context/engine";
import { applyProtocolRegions, buildAgentScopeSection } from "../prompts/sections";
import type { AgentRunOptions } from "./types";

/**
 * Build a concrete call payload for the first advertised tool.
 *
 * The preamble used to show a fixed `{"key":"value"}`, which named no real
 * argument — so an agent had to infer the key, and a wrong guess reached the
 * handler as a missing argument. Deriving the example from the descriptor's
 * own schema means the one worked example is always a valid call.
 *
 * Placeholders are typed rather than invented (`"<string>"`, not a fabricated
 * path) so the example can never be mistaken for a real value to send back.
 */
function renderCallExample(tool: ToolDescriptor): string {
  const properties = tool.inputSchema.properties;
  if (typeof properties !== "object" || properties === null) return "{}";

  const entries = Object.entries(properties as Record<string, unknown>);
  const required = new Set(
    Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required.filter((name): name is string => typeof name === "string")
      : [],
  );

  // Required arguments make the example a valid call; when none are declared,
  // the first optional one still shows the payload shape.
  const shown = entries.filter(([name]) => required.has(name));
  const chosen = shown.length > 0 ? shown : entries.slice(0, 1);
  if (chosen.length === 0) return "{}";

  const fields = chosen.map(([name, raw]) => {
    const spec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const type = typeof spec.type === "string" ? spec.type : "any";
    const placeholder = type === "number" ? "1" : type === "boolean" ? "true" : `"<${type}>"`;
    return `"${name}": ${placeholder}`;
  });

  return `{${fields.join(", ")}}`;
}

/**
 * Render a pull tool's JSON Schema as an agent-readable argument list.
 *
 * The descriptors have always carried a full `inputSchema`, but the preamble
 * used to advertise only name + description — so an agent was told
 * `query_neighbor` exists and never told it needs `filePath`. It had to guess
 * the payload, and a guessed `{}` produced an empty result. Rendering the
 * schema is what closes that gap.
 *
 * Kept tolerant of a partial schema (no `properties`, no `required`, a
 * type-less property): a descriptor that omits a field degrades to a coarser
 * line rather than throwing inside prompt assembly.
 */
function renderToolArguments(inputSchema: Record<string, unknown>): string {
  const properties = inputSchema.properties;
  if (typeof properties !== "object" || properties === null) return "";

  const required = new Set(
    Array.isArray(inputSchema.required) ? inputSchema.required.filter((name) => typeof name === "string") : [],
  );

  const lines = Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const spec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const type = typeof spec.type === "string" ? spec.type : "any";
    const necessity = required.has(name) ? "required" : "optional";
    const description = typeof spec.description === "string" ? `: ${spec.description}` : "";
    return `  - ${name} (${type}, ${necessity})${description}`;
  });

  return lines.length > 0 ? `\n  Arguments:\n${lines.join("\n")}` : "";
}

export function buildContextToolPreamble(options: AgentRunOptions): string {
  const tools = options.contextPullTools;
  if (!tools || tools.length === 0 || !options.contextToolRuntime) {
    return options.prompt;
  }

  const toolList = tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description} (max ${tool.maxCallsPerSession} calls/session)` +
        renderToolArguments(tool.inputSchema),
    )
    .join("\n");

  const example = tools[0];
  const exampleCall = example
    ? `<nax_tool_call name="${example.name}">\n${renderCallExample(example)}\n</nax_tool_call>`
    : "";

  return `${options.prompt}

## Context Pull Tools
When you need more repo context, you may request one tool call by replying with exactly:
${exampleCall}

Pass the arguments listed for the tool you are calling.

Available tools:
${toolList}

After you receive a <nax_tool_result ...> block, continue the task normally.`;
}

/**
 * Build the dispatch prompt for `agentName`, prefixing the scope block.
 *
 * The scope block is prepended on BOTH arms: the boundary is a property of the
 * tools, not of the transport, and an ACP agent is as blind to it as a native
 * one. It goes here rather than in a per-op section because every dispatch has
 * a root and none of the op builders can see it.
 */
export function promptWithToolPreamble(agentName: string, options: AgentRunOptions): string {
  const base = agentName === NATIVE_AGENT ? options.prompt : buildContextToolPreamble(options);
  const scope = buildAgentScopeSection(options.codingToolRoot, options.codingToolWorkdirLabel);
  return scope === undefined ? base : `${scope}\n\n${base}`;
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
