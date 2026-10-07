/**
 * ACP output helpers — context tool parsing, response extraction, and
 * interaction handler wiring. Extracted from adapter.ts.
 */

import type { ToolDescriptor } from "@/context/engine";
import type { ITokenUsageMapper, RateCard, TokenUsage } from "../cost";
import { priceCall } from "../cost";
import { assembleTurnResult } from "../turn";
import type { AgentRunOptions, InteractionExchange, TurnResult } from "../types";
import type { AcpSessionResponse } from "./adapter-session-types";
import type { SessionTokenUsage } from "./wire-types";

// ─────────────────────────────────────────────────────────────────────────────
// Response output helpers
// ─────────────────────────────────────────────────────────────────────────────

export function extractOutput(response: { messages: Array<{ role: string; content: string }> } | null): string {
  if (!response) return "";
  return response.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("\n")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Context tool helpers
// ─────────────────────────────────────────────────────────────────────────────

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

export { buildRunInteractionHandler } from "../run-interaction-handler";

// ─────────────────────────────────────────────────────────────────────────────
// Turn result assembly (US-001)
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildTurnResultInput {
  /** Final ACP response from the last turn — null when the turn timed out or aborted. */
  lastResponse: AcpSessionResponse | null;
  /** Accumulated token usage across all turns. */
  totalTokenUsage: TokenUsage;
  /** Accumulated exact cost from `exactCostUsd` events (undefined when wire never reported). */
  totalExactCostUsd: number | undefined;
  /** Number of `session.prompt()` calls made. */
  turnCount: number;
  /** Mid-turn human-in-the-loop exchanges (issue #1226). */
  interactions: readonly InteractionExchange[];
  /** True when sendTurn returned because the wall-clock timeout elapsed (US-001). */
  timedOut: boolean;
  /** Resolved rate card (US-002). Replaces `modelDef` so `buildTurnResult` prices from `rateCard.rates` and stamps `rateCard.source` on `pricingSource`. */
  rateCard: RateCard;
}

/**
 * Token/cost math shared by complete()'s success and cancelled-but-billable
 * paths. US-002: prices from the resolved rate card rather than the model
 * string, so both paths bill on the card `complete()` resolved once.
 *
 * US-002: also stamps `rates` (the post-tier, post-fallback
 * `PricingRates`) onto the returned shape whenever nonzero usage let
 * `priceCall` run. Zero usage skips pricing entirely — the field is
 * omitted (not set to undefined, not zeroed) so the nonzero-usage guard
 * stays visible to the downstream cost subscriber.
 *
 * Extracted from `adapter.ts` so the body of `complete()` could move under
 * the file-size cap — the helper has no `this` dependency.
 */
export function deriveTokenUsage(
  wire: SessionTokenUsage | undefined,
  rateCard: RateCard,
  mapper: ITokenUsageMapper<SessionTokenUsage>,
): {
  tokenUsage: TokenUsage;
  estimatedCostUsd: number;
  rates: ReturnType<typeof priceCall>["resolvedRates"] | undefined;
} {
  const tokenUsage = wire ? mapper.toInternal(wire) : { inputTokens: 0, outputTokens: 0 };
  const nonzeroUsage = tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0;
  // Single `priceCall` invocation: `costUsd` and `resolvedRates` come from
  // the same call so they cannot diverge — same verifiability concern as
  // `buildTurnResult` above.
  const priced = nonzeroUsage ? priceCall(tokenUsage, rateCard.rates) : undefined;
  return {
    tokenUsage,
    estimatedCostUsd: priced?.costUsd ?? 0,
    // US-002: same nonzero-usage guard as the cost itself. `rates` is only
    // populated when pricing ran, so the field's absence encodes
    // "did not price".
    rates: priced?.resolvedRates,
  };
}

/**
 * acpx wrapper over the shared `assembleTurnResult` (S4b-1, D1-d): reads the
 * assistant text off the acpx response shape. Deleted with agents/acp/ in S4b-5.
 */
export function buildTurnResult(input: BuildTurnResultInput): TurnResult {
  const { lastResponse, ...rest } = input;
  return assembleTurnResult({ ...rest, output: extractOutput(lastResponse) });
}
