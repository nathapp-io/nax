/**
 * ACP output helpers — context tool parsing, response extraction, and
 * interaction handler wiring. Extracted from adapter.ts.
 */

import type { InteractionHandler } from "../interaction-handler";
import type { AgentRunOptions } from "../types";

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

  // BUG-097: Only check the last non-empty line for question marks.
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

function buildContextToolResult(name: string, result: string, status: "ok" | "error" = "ok"): string {
  return `<nax_tool_result name="${name}" status="${status}">
${result.trim()}
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
