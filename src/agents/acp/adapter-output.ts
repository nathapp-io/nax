/**
 * ACP output helpers — context tool parsing, response extraction, and
 * interaction handler wiring. Extracted from adapter.ts.
 */

import type { ModelDef } from "@/config/schema";
import type { TokenUsage } from "../cost";
import { estimateCostFromTokenUsage } from "../cost";
import type { InteractionHandler } from "../interaction-handler";
import type { AgentRunOptions, InteractionExchange, TurnResult } from "../types";
import type { AcpSessionResponse } from "./adapter-session-types";

const CONTEXT_TOOL_CALL_PATTERN = /<nax_tool_call\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/nax_tool_call>/i;

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

export function extractQuestion(output: string): string | null {
  const text = output.trim();
  if (!text) return null;

  // @design: BUG-097: Only check the last non-empty line for question marks.
  // Scanning all sentences caused false positives on code snippets mid-output
  // containing ?. (optional chaining), ?? (nullish coalescing), or ternary ?.
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines.at(-1)?.trim() ?? "";

  // Keyword markers — also scoped to the last line to avoid mid-message false positives
  const lower = lastLine.toLowerCase();
  const markers = [
    "please confirm",
    "please specify",
    "please provide",
    "which would you",
    "should i ",
    "do you want",
    "can you clarify",
  ];

  const isQuestion = (lastLine.endsWith("?") && lastLine.length > 10) || markers.some((m) => lower.includes(m));

  if (!isQuestion) return null;

  // Return the last two paragraphs so the caller has full context.
  //
  // Agents often structure their final turn as:
  //   <long output: tables, code blocks, AC coverage>
  //   \n\n
  //   <conclusion sentence>   ← paragraph[-2]
  //   \n\n
  //   <question>              ← paragraph[-1]
  //
  // Returning only paragraph[-1] drops the conclusion sentence that explains
  // WHY the agent is asking — leaving the user without meaningful context.
  const paragraphs = text.split(/\n\n+/);
  const questionPara = paragraphs.at(-1)?.trim() ?? lastLine;
  const contextPara = paragraphs.at(-2)?.trim();
  return contextPara ? `${contextPara}\n\n${questionPara}` : questionPara;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context tool helpers
// ─────────────────────────────────────────────────────────────────────────────

export function extractContextToolCall(output: string): { name: string; input?: unknown; error?: string } | null {
  const match = output.match(CONTEXT_TOOL_CALL_PATTERN);
  if (!match) return null;

  const [, name, rawInput] = match;
  const trimmedInput = rawInput.trim();
  if (!trimmedInput) {
    return { name, input: {} };
  }

  try {
    return { name, input: JSON.parse(trimmedInput) as unknown };
  } catch (error) {
    return {
      name,
      error: `Invalid JSON tool input: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function buildContextToolPreamble(options: AgentRunOptions): string {
  const tools = options.contextPullTools;
  if (!tools || tools.length === 0 || !options.contextToolRuntime) {
    return options.prompt;
  }

  const toolList = tools
    .map((tool) => `- ${tool.name}: ${tool.description} (max ${tool.maxCallsPerSession} calls/session)`)
    .join("\n");

  return `${options.prompt}

## Context Pull Tools
When you need more repo context, you may request one tool call by replying with exactly:
<nax_tool_call name="tool_name">
{"key":"value"}
</nax_tool_call>

Available tools:
${toolList}

After you receive a <nax_tool_result ...> block, continue the task normally.`;
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeResultBody(body: string): string {
  return body.replace(/<\//g, "<\\/");
}

function buildContextToolResult(name: string, result: string, status: "ok" | "error" = "ok"): string {
  return `<nax_tool_result name="${escapeAttributeValue(name)}" status="${status}">
${escapeResultBody(result.trim())}
</nax_tool_result>

Continue the task.`;
}

export function buildRunInteractionHandler(options: AgentRunOptions): InteractionHandler {
  const { contextToolRuntime, contextPullTools, interactionBridge } = options;
  const hasContextTools = Boolean(contextToolRuntime && (contextPullTools?.length ?? 0) > 0);

  return {
    async onInteraction(req) {
      if (req.kind === "context-tool") {
        if (!hasContextTools || !contextToolRuntime) return null;
        try {
          const toolResult = req.error
            ? buildContextToolResult(req.name, req.error, "error")
            : buildContextToolResult(req.name, await contextToolRuntime.callTool(req.name, req.input ?? {}));
          return { answer: toolResult };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { answer: buildContextToolResult(req.name, msg, "error") };
        }
      }
      if (req.kind === "question") {
        if (!interactionBridge) return null;
        const answer = await interactionBridge.onQuestionDetected(req.text);
        return { answer };
      }
      return null;
    },
  };
}

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
  /** Resolved model definition — used for token-based cost estimation. */
  modelDef: ModelDef;
}

/**
 * Build a `TurnResult` from the accumulated session-turn bookkeeping.
 * Extracted from `AcpAgentAdapter.sendTurn()` so the timeout transport fact
 * (`timedOut`) is set in exactly one place (US-001 AC1/AC2/AC3).
 *
 * When `timedOut` is true, output is forced to "" regardless of any leftover
 * lastResponse — the wall-clock timeout must not leak partial agent output
 * into the policy layer.
 */
export function buildTurnResult(input: BuildTurnResultInput): TurnResult {
  const { lastResponse, totalTokenUsage, totalExactCostUsd, turnCount, interactions, timedOut, modelDef } = input;

  const output = timedOut ? "" : extractOutput(lastResponse);

  const estimatedCostUsd =
    totalTokenUsage.inputTokens > 0 || totalTokenUsage.outputTokens > 0
      ? estimateCostFromTokenUsage(totalTokenUsage, modelDef.model)
      : 0;

  return {
    output,
    tokenUsage: totalTokenUsage,
    estimatedCostUsd,
    exactCostUsd: totalExactCostUsd,
    internalRoundTrips: turnCount,
    ...(interactions.length > 0 ? { interactions } : {}),
    timedOut,
  };
}
