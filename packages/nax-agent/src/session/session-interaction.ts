/**
 * The facade's InteractionHandler (spec 5.1, 4.3, 6.1). Routes each loop
 * request:
 * - question -> the pending-ask table (null on timeout or cancel, which the
 *   loop answers with its no-operator text);
 * - an embedder tool -> its own run, after an approval when it is "always";
 * - a built-in coding tool -> the session's CodingToolRuntime, with the call
 *   id in the current-call slot so a policy ask can name it.
 * A failed tool is reported by throwing: the tool batch turns a handler throw
 * into an isError result whose content is the thrown message.
 */
import { NaxError } from "#src/infra/nax-error";
import { redactSecrets } from "#src/internal/redact";
import { askDenyReason } from "#src/tools/ask-request";
import type { CodingTool } from "#src/tools/registry";
import type { CodingToolRuntime, ToolCallContext } from "#src/tools/runtime";
import { cutToByteCap } from "#src/tools/truncate";
import type { EmbedderTool, EmbedderToolContext, EmbedderToolResult } from "./agent-session-types.ts";
import type { AdapterInteraction, AdapterInteractionResponse, InteractionHandler } from "./interaction-handler.ts";
import { askPerson, type SessionAskDeps } from "./session-ask-link.ts";

/** Byte cap on an embedder approval's default summary. */
export const EMBEDDER_SUMMARY_BYTES = 1024;

type CodingToolRequest = Extract<AdapterInteraction, { kind: "coding-tool" }>;

export interface SessionInteractionDeps {
  readonly sessionId: string;
  readonly runtime: CodingToolRuntime;
  readonly embedderTools: ReadonlyMap<string, EmbedderTool>;
  readonly asks: SessionAskDeps;
  /** The running turn's signal (a never-aborting one between turns). */
  readonly turnSignal: () => AbortSignal;
  readonly setCurrentCallId: (callId: string | undefined) => void;
}

/** What the model sees of an embedder tool. The facade's handler runs it; this run is never reached. */
export function embedderToolDescriptor(tool: EmbedderTool): CodingTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    scope: { pathFields: [] },
    async run() {
      return { content: `"${tool.name}" runs through the agent session, not the coding-tool runtime.`, isError: true };
    },
  };
}

export function defaultSummary(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(redactSecrets(input)) ?? "null";
  } catch {
    return "[input not serializable]";
  }
  return cutToByteCap(json, EMBEDDER_SUMMARY_BYTES);
}

function toolError(message: string, tool: string): NaxError {
  return new NaxError(message, "AGENT_SESSION_TOOL_ERROR", { stage: "agent-session", tool });
}

function summaryFor(tool: EmbedderTool, input: unknown): string {
  if (tool.describe === undefined) return defaultSummary(input);
  try {
    return cutToByteCap(redactSecrets(String(tool.describe(input))), EMBEDDER_SUMMARY_BYTES);
  } catch {
    return defaultSummary(input);
  }
}

function runSafely(tool: EmbedderTool, input: unknown, ctx: EmbedderToolContext): Promise<EmbedderToolResult> {
  return Promise.resolve()
    .then(() => tool.run(input, ctx))
    .catch((err: unknown) => {
      const cause = err instanceof Error ? err.message : String(err);
      return { content: `Tool "${tool.name}" failed: ${cause}`, isError: true };
    });
}

/**
 * Runs the tool, but answers at once when the turn aborts: the batch awaits
 * this handler with no abort race of its own, so a run that ignores its signal
 * would otherwise hang the turn. The abandoned run's late settlement is ignored.
 */
async function invoke(tool: EmbedderTool, input: unknown, ctx: EmbedderToolContext): Promise<EmbedderToolResult> {
  const abandoned: EmbedderToolResult = {
    content: `Tool "${tool.name}" was abandoned: the turn ended.`,
    isError: true,
  };
  if (ctx.signal.aborted) return abandoned;
  let onAbort = (): void => {};
  const aborted = new Promise<EmbedderToolResult>((resolve) => {
    onAbort = () => resolve(abandoned);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([runSafely(tool, input, ctx), aborted]);
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

async function runEmbedderTool(
  deps: SessionInteractionDeps,
  tool: EmbedderTool,
  request: CodingToolRequest,
): Promise<AdapterInteractionResponse> {
  const toolCallId = request.toolCallId ?? "";
  const signal = request.signal ?? deps.turnSignal();
  const input = request.input ?? {};
  if (tool.approval === "always") {
    const ask = {
      tool: tool.name,
      summary: summaryFor(tool, input),
      reason: `"${tool.name}" asks before every run`,
      callId: toolCallId,
    };
    const outcome = await askPerson(deps.asks, ask, signal);
    if (outcome.decision !== "allow") {
      const reason = askDenyReason(outcome.decidedBy);
      return { answer: `Denied: ${reason}`, denied: { reason, breach: false } };
    }
  }
  const result = await invoke(tool, input, { sessionId: deps.sessionId, toolCallId, signal });
  if (result.isError === true) throw toolError(result.content, tool.name);
  return { answer: result.content };
}

function toolCallContext(request: CodingToolRequest): ToolCallContext {
  return {
    ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
    ...(request.roundTrips !== undefined ? { roundTrips: request.roundTrips } : {}),
    ...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
    ...(request.deferModelTruncation !== undefined ? { deferModelTruncation: request.deferModelTruncation } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...(request.onWaiting !== undefined ? { onWaiting: request.onWaiting } : {}),
  };
}

async function runCodingTool(
  deps: SessionInteractionDeps,
  request: CodingToolRequest,
): Promise<AdapterInteractionResponse> {
  deps.setCurrentCallId(request.toolCallId);
  try {
    const outcome = await deps.runtime.callTool(request.name, request.input ?? {}, toolCallContext(request));
    if (outcome.kind === "denied") {
      return { answer: `Denied: ${outcome.reason}`, denied: { reason: outcome.reason, breach: outcome.breach } };
    }
    if (outcome.kind === "error") throw toolError(outcome.content, request.name);
    return { answer: outcome.content };
  } finally {
    deps.setCurrentCallId(undefined);
  }
}

async function answerQuestion(deps: SessionInteractionDeps, text: string): Promise<AdapterInteractionResponse | null> {
  const { requestId, expiresAt, settled } = deps.asks.table.issue("question", deps.turnSignal());
  deps.asks.emit({ type: "question", requestId, text, expiresAt });
  const settlement = await settled;
  return settlement.by === "human" && "text" in settlement.reply ? { answer: settlement.reply.text } : null;
}

export function createSessionInteractionHandler(deps: SessionInteractionDeps): InteractionHandler {
  return {
    async onInteraction(request) {
      if (request.kind === "question") return answerQuestion(deps, request.text);
      if (request.kind === "context-tool") throw toolError(`Unknown tool "${request.name}"`, request.name);
      const tool = deps.embedderTools.get(request.name);
      return tool !== undefined ? runEmbedderTool(deps, tool, request) : runCodingTool(deps, request);
    },
  };
}
