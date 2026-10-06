/**
 * Embedder tools as the MCP tool host serves them (S4 spec §6.6: tools/list and
 * tools/call). A call runs only while a turn runs, at most
 * MAX_CONCURRENT_TOOL_CALLS at once, under the turn's binding signal (cancel,
 * timeout, close, turn end, agent process exit) combined with its HTTP request's
 * (D4-f). `approval: "never"` runs under every profile, as on the native backend;
 * anything else asks the caller first. Adapter pre-approval (R12) makes this the
 * tools' only approval point. Every failure reaches the agent as an MCP tool error
 * (isError), never as a protocol error.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  type ApprovalDecidedBy,
  ASK_CANCELLED_REASON,
  ASK_DENIED_REASON,
  ASK_NO_CHANNEL_REASON,
  ASK_PROFILE_REASON,
  ASK_TIMEOUT_REASON,
  ASK_UNSHOWABLE_REASON,
  capStrings,
  type EmbedderTool,
  type EmbedderToolContext,
  type EmbedderToolResult,
  redactSecrets,
  type SessionAskPort,
} from "@nathapp/nax-agent";
import { capBytes, scrubSecrets, stripControl, stripInvisible } from "#src/client/text";

export const MAX_CONCURRENT_TOOL_CALLS = 8;
/** Byte cap of an approval summary (native: EMBEDDER_SUMMARY_BYTES). */
export const TOOL_SUMMARY_BYTES = 1024;
/** Redaction scans at most this many bytes of a tool input (native: 16x the summary cap). */
const SCAN_BYTES = TOOL_SUMMARY_BYTES * 16;
const SHOWN_NAME_CHARS = 64;

export const NO_TURN_TEXT = "No active turn: embedder tools run only while a turn is running.";
export const TOO_MANY_TEXT = `Too many concurrent tool calls: at most ${MAX_CONCURRENT_TOOL_CALLS} run at once.`;

export interface ToolCallDeps {
  readonly sessionId: string;
  readonly tools: readonly EmbedderTool[];
  readonly asks: SessionAskPort;
  readonly currentTurnId: () => string | undefined;
  /** The running turn's binding signal (inbound.ts activeSignal), or undefined between turns. */
  readonly turnSignal: () => AbortSignal | undefined;
  /** The session's secret values (env secrets and the host token), scrubbed from approval summaries. */
  readonly secrets: readonly string[];
}

export interface ToolCalls {
  /** tools/list: exactly the session's embedder tools. */
  list(): Tool[];
  /** tools/call. `requestSignal` aborts when the HTTP request goes away. */
  call(name: string, args: unknown, requestSignal: AbortSignal): Promise<CallToolResult>;
  /** Resolves once every call in flight has answered. */
  drain(): Promise<void>;
}

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** The native backend's reason for an embedder approval. */
export function approvalReason(name: string): string {
  return `"${name}" asks before every run`;
}

/** nax-agent's askDenyReason, over its public reason constants. */
export function denyReason(decidedBy: ApprovalDecidedBy): string {
  switch (decidedBy) {
    case "timeout":
      return ASK_TIMEOUT_REASON;
    case "human":
      return ASK_DENIED_REASON;
    case "cancelled":
      return ASK_CANCELLED_REASON;
    case "unshowable":
      return ASK_UNSHOWABLE_REASON;
    case "profile":
      return ASK_PROFILE_REASON;
    default:
      return ASK_NO_CHANNEL_REASON;
  }
}

function describeInput(tool: EmbedderTool, input: unknown): string {
  if (tool.describe !== undefined) {
    try {
      return String(redactSecrets(capStrings(String(tool.describe(input)), SCAN_BYTES)));
    } catch {
      // A throwing describe falls back to the input, as on the native backend.
    }
  }
  try {
    return JSON.stringify(redactSecrets(capStrings(input, SCAN_BYTES))) ?? "null";
  } catch {
    return "[input not serializable]";
  }
}

/** The approval summary (D4-h): described or JSON input, redacted, stripped, the session's secrets scrubbed, one line, capped. */
export function toolSummary(tool: EmbedderTool, input: unknown, secrets: readonly string[]): string {
  const visible = scrubSecrets(stripInvisible(stripControl(describeInput(tool, input))), secrets);
  return capBytes(visible.replace(/[\n\t]+/g, " ").trim(), TOOL_SUMMARY_BYTES);
}

function abandoned(name: string): CallToolResult {
  return textResult(`Tool "${name}" was abandoned: the turn ended.`, true);
}

function runSafely(tool: EmbedderTool, input: unknown, ctx: EmbedderToolContext): Promise<CallToolResult> {
  return Promise.resolve()
    .then(() => tool.run(input, ctx))
    .then(
      (result: EmbedderToolResult | undefined | null) =>
        result === undefined || result === null
          ? textResult(`Tool "${tool.name}" returned no result.`, true)
          : textResult(String(result.content), result.isError === true),
      (err: unknown) =>
        textResult(`Tool "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`, true),
    );
}

/** Answers at once when the signal aborts: a run that ignores its signal is abandoned and its late result ignored. */
async function invoke(tool: EmbedderTool, input: unknown, ctx: EmbedderToolContext): Promise<CallToolResult> {
  if (ctx.signal.aborted) return abandoned(tool.name);
  let onAbort = (): void => {};
  const aborted = new Promise<CallToolResult>((resolve) => {
    onAbort = () => resolve(abandoned(tool.name));
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([runSafely(tool, input, ctx), aborted]);
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

/** undefined: go ahead. Otherwise the answer that replaces the run. */
async function approve(
  deps: ToolCallDeps,
  tool: EmbedderTool,
  input: unknown,
  ctx: EmbedderToolContext,
): Promise<CallToolResult | undefined> {
  if (tool.approval === "never") return undefined;
  try {
    const outcome = await deps.asks.requestApproval({
      callId: ctx.toolCallId,
      tool: tool.name,
      summary: toolSummary(tool, input, deps.secrets),
      reason: approvalReason(tool.name),
      signal: ctx.signal,
    });
    return outcome.decision === "allow" ? undefined : textResult(`Denied: ${denyReason(outcome.decidedBy)}`, true);
  } catch {
    // The turn ended between the turn check and the ask (the port's "no-turn"): fail closed.
    return textResult(NO_TURN_TEXT, true);
  }
}

export function createToolCalls(deps: ToolCallDeps): ToolCalls {
  const byName: ReadonlyMap<string, EmbedderTool> = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const inFlight = new Set<Promise<CallToolResult>>();
  let accepted = 0;

  const run = async (tool: EmbedderTool, args: unknown, signal: AbortSignal): Promise<CallToolResult> => {
    accepted += 1;
    const input = args ?? {};
    const ctx: EmbedderToolContext = { sessionId: deps.sessionId, toolCallId: `mcp-${accepted}`, signal };
    if (signal.aborted) return abandoned(tool.name);
    const denied = await approve(deps, tool, input, ctx);
    return denied ?? invoke(tool, input, ctx);
  };

  return {
    list: () =>
      deps.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { ...tool.inputSchema, type: "object" },
        // #2365: this host is the tools' only approval point. Claude's plan mode
        // (profiles none/read) asks before any MCP tool not marked read-only,
        // ahead of the mcp__nax__<tool> pre-approval.
        annotations: { readOnlyHint: true },
      })),
    async call(name, args, requestSignal) {
      const tool = byName.get(name);
      if (tool === undefined) {
        return textResult(`Unknown tool "${stripControl(name).slice(0, SHOWN_NAME_CHARS)}"`, true);
      }
      const turnSignal = deps.turnSignal();
      if (deps.currentTurnId() === undefined || turnSignal === undefined) return textResult(NO_TURN_TEXT, true);
      if (inFlight.size >= MAX_CONCURRENT_TOOL_CALLS) return textResult(TOO_MANY_TEXT, true);
      const pending = run(tool, args, AbortSignal.any([turnSignal, requestSignal]));
      inFlight.add(pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(pending);
      }
    },
    async drain() {
      await Promise.allSettled([...inFlight]);
    },
  };
}
