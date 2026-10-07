/**
 * Parsing of agent output for mid-turn interactions: a human question or a
 * `<nax_tool_call>` context-tool request (the text protocol, spec B5).
 *
 * Moved out of agents/acp/ in S4b-1. Both ACP transports read the same
 * reply text, so they share one parser.
 */

/** A `<nax_tool_call>` request parsed from agent output. `error` is set when the JSON body is invalid. */
export interface ContextToolCall {
  name: string;
  input?: unknown;
  error?: string;
}

const CONTEXT_TOOL_CALL_PATTERN = /<nax_tool_call\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/nax_tool_call>/i;

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

export function extractContextToolCall(output: string): ContextToolCall | null {
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
