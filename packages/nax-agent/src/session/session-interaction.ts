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
import { capStrings, redactSecrets } from "#src/internal/redact";
import { askDenyReason } from "#src/tools/ask-request";
import type { CodingTool } from "#src/tools/registry";
import type { CodingToolOutcome, CodingToolRuntime, ToolCallContext } from "#src/tools/runtime";
import { cutToByteCap } from "#src/tools/truncate";
import type { EmbedderTool, EmbedderToolContext, EmbedderToolResult } from "./agent-session-types.ts";
import type { AdapterInteraction, AdapterInteractionResponse, InteractionHandler } from "./interaction-handler.ts";
import type { SessionAskPort } from "./session-backend.ts";

/** Byte cap on an embedder approval's default summary. */
export const EMBEDDER_SUMMARY_BYTES = 1024;

/**
 * Ceiling on a tool's declared post-abort grace (US-003). A tool that asks for
 * longer is clamped: the turn is already cancelled, and a long grace would hold
 * `close()` open on the person who pressed Esc.
 */
export const MAX_CANCEL_GRACE_MS = 10_000;

/**
 * Redaction scans at most this many bytes of an embedder tool input; the
 * summary keeps far fewer. Same 16x pattern as `turn-event-emitter.ts`'s
 * `REDACTION_SCAN_BYTES` so the bound is comparable to a tool-call input.
 */
const EMBEDDER_SCAN_BYTES = EMBEDDER_SUMMARY_BYTES * 16;

type CodingToolRequest = Extract<AdapterInteraction, { kind: "coding-tool" }>;

export interface SessionInteractionDeps {
  readonly sessionId: string;
  readonly runtime: CodingToolRuntime;
  readonly embedderTools: ReadonlyMap<string, EmbedderTool>;
  /** Declared coding tools withheld by the runtime's advertisement policy. Never execute these calls. */
  readonly unavailableTools?: ReadonlySet<string>;
  readonly asks: SessionAskPort;
  /** The running turn's signal (a never-aborting one between turns). */
  readonly turnSignal: () => AbortSignal;
  readonly setCurrentCallId: (callId: string | undefined) => void;
  /**
   * US-003: qualified tool name -> the grace that tool may take after the turn
   * aborts. Absent, or a name missing from the map, means the generic
   * abandoned outcome the moment the signal aborts. A declared value is
   * normalised before use: non-finite or `<= 0` is no grace, and anything
   * above `MAX_CANCEL_GRACE_MS` is that ceiling.
   */
  readonly cancelGraceByTool?: ReadonlyMap<string, number>;
  /** The timer seam the grace runs on. Defaults to the process globals. */
  readonly timers?: {
    readonly setTimeout: (fn: () => void, ms: number) => unknown;
    readonly clearTimeout: (id: unknown) => void;
  };
}

type SessionTimers = NonNullable<SessionInteractionDeps["timers"]>;

/**
 * Process-global timers. The grace arms a handle it must cancel on every
 * settle path, which is the sanctioned reason to use `setTimeout` here rather
 * than `Bun.sleep`: a sleep cannot be cleared, so a tool that answers promptly
 * would still hold the turn for the whole grace.
 */
const PROCESS_TIMERS: SessionTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  // The handle is a number on Bun and a Timeout object on Node; the seam keeps
  // it opaque, so this is the one place that recovers the concrete type.
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
};

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
    // Cap before redactSecrets walks: a multi-MB tool input must not run
    // every SECRET_VALUE_PATTERNS regex (PEM block up to 64KB per match)
    // over megabytes. The post-serialize cutToByteCap is the display cap;
    // this is the scan cap.
    json = JSON.stringify(redactSecrets(capStrings(input, EMBEDDER_SCAN_BYTES))) ?? "null";
  } catch {
    return "[input not serializable]";
  }
  return cutToByteCap(json, EMBEDDER_SUMMARY_BYTES);
}

function toolError(message: string, tool: string, sandbox?: "sandboxed" | "unsandboxed"): NaxError {
  return new NaxError(message, "AGENT_SESSION_TOOL_ERROR", {
    stage: "agent-session",
    tool,
    ...(sandbox !== undefined ? { sandbox } : {}),
  });
}

function summaryFor(tool: EmbedderTool, input: unknown): string {
  if (tool.describe === undefined) return defaultSummary(input);
  try {
    // Same bound as defaultSummary: cap first, then redact, then display-cut.
    // capStrings preserves the string's type at runtime; the cast is the
    // single point where the generic is recovered for cutToByteCap.
    const described = redactSecrets(capStrings(String(tool.describe(input)), EMBEDDER_SCAN_BYTES)) as string;
    return cutToByteCap(described, EMBEDDER_SUMMARY_BYTES);
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
 * Settle with `work`, or with `onAbort()` the moment `signal` aborts. The tool
 * batch awaits interaction handlers with no abort race of its own, so a tool
 * that ignores its signal would otherwise hang the turn (and `close()`, which
 * awaits the turn). The abandoned work's late settlement is ignored.
 */
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  let listener = (): void => {};
  const aborted = new Promise<T>((resolve) => {
    listener = () => resolve(onAbort());
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

/**
 * Runs the tool, but answers at once when the turn aborts: the batch awaits
 * this handler with no abort race of its own, so a run that ignores its signal
 * would otherwise hang the turn. See `raceAbort`.
 */
async function invoke(tool: EmbedderTool, input: unknown, ctx: EmbedderToolContext): Promise<EmbedderToolResult> {
  const abandoned: EmbedderToolResult = {
    content: `Tool "${tool.name}" was abandoned: the turn ended.`,
    isError: true,
  };
  if (ctx.signal.aborted) return abandoned;
  return raceAbort(runSafely(tool, input, ctx), ctx.signal, () => abandoned);
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
    const outcome = await deps.asks.requestApproval({ ...ask, signal });
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

/**
 * A declared grace, normalised: non-finite or non-positive means the tool has
 * none to offer, and anything above `MAX_CANCEL_GRACE_MS` is that ceiling.
 */
function normaliseCancelGrace(declared: number | undefined): number | undefined {
  if (declared === undefined || !Number.isFinite(declared) || declared <= 0) return undefined;
  return Math.min(declared, MAX_CANCEL_GRACE_MS);
}

/**
 * Settle with `work`, or with `onExpire()` once `signal` has been aborted for
 * `graceMs`. That window is a provider tool's chance to answer its own
 * cancellation (US-003) — the outcome it returns still maps exactly as an
 * unaborted call's does. A settlement after the window is observed and
 * ignored, and its rejection handler is attached up front so a late rejection
 * is never unhandled. The timer is cleared on every settle path.
 */
function raceCancelGrace<T>(options: {
  readonly work: Promise<T>;
  readonly signal: AbortSignal;
  readonly graceMs: number;
  readonly timers: SessionTimers;
  readonly onExpire: () => T;
}): Promise<T> {
  const { work, signal, graceMs, timers, onExpire } = options;
  return new Promise<T>((resolve, reject) => {
    let timer: unknown;
    let settled = false;
    const settle = (answer: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", startGrace);
      if (timer !== undefined) timers.clearTimeout(timer);
      answer();
    };
    function startGrace(): void {
      timer = timers.setTimeout(() => settle(() => resolve(onExpire())), graceMs);
    }
    work.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
    if (signal.aborted) startGrace();
    else signal.addEventListener("abort", startGrace, { once: true });
  });
}

/**
 * One coding-tool call, raced against the turn's abort: at once when the tool
 * declares no grace, or within that grace when it does — which is how a
 * provider tool returns its own outcome after the person pressed Esc.
 */
async function callTool(
  deps: SessionInteractionDeps,
  request: CodingToolRequest,
  signal: AbortSignal,
  abandoned: CodingToolOutcome,
): Promise<CodingToolOutcome> {
  const work = deps.runtime.callTool(request.name, request.input ?? {}, { ...toolCallContext(request), signal });
  const graceMs = normaliseCancelGrace(deps.cancelGraceByTool?.get(request.name));
  if (graceMs === undefined) return raceAbort(work, signal, () => abandoned);
  return raceCancelGrace({ work, signal, graceMs, timers: deps.timers ?? PROCESS_TIMERS, onExpire: () => abandoned });
}

/** Map a tool outcome onto the handler's answer, denial or throw. */
function answerFor(outcome: CodingToolOutcome, name: string): AdapterInteractionResponse {
  if (outcome.kind === "denied") {
    return { answer: `Denied: ${outcome.reason}`, denied: { reason: outcome.reason, breach: outcome.breach } };
  }
  if (outcome.kind === "error") throw toolError(outcome.content, name, outcome.sandbox);
  return { answer: outcome.content, ...(outcome.sandbox !== undefined ? { sandbox: outcome.sandbox } : {}) };
}

async function runCodingTool(
  deps: SessionInteractionDeps,
  request: CodingToolRequest,
): Promise<AdapterInteractionResponse> {
  deps.setCurrentCallId(request.toolCallId);
  try {
    const signal = request.signal ?? deps.turnSignal();
    const abandoned: CodingToolOutcome = {
      kind: "error",
      content: `Tool "${request.name}" was abandoned: the turn ended.`,
    };
    // An already-aborted signal never reaches the tool, grace or no grace.
    return answerFor(signal.aborted ? abandoned : await callTool(deps, request, signal, abandoned), request.name);
  } finally {
    deps.setCurrentCallId(undefined);
  }
}

async function answerQuestion(deps: SessionInteractionDeps, text: string): Promise<AdapterInteractionResponse | null> {
  const answer = await deps.asks.askQuestion(text);
  return answer === null ? null : { answer };
}

export function createSessionInteractionHandler(deps: SessionInteractionDeps): InteractionHandler {
  return {
    async onInteraction(request) {
      if (request.kind === "question") return answerQuestion(deps, request.text);
      if (request.kind === "context-tool") {
        // A model may still call a denied tool it remembers from earlier turns.
        // Keep it hidden, but distinguish a policy refusal from an unknown name.
        if (deps.unavailableTools?.has(request.name)) {
          const reason = `Tool "${request.name}" is not available under the session policy`;
          return { answer: `Denied: ${reason}`, denied: { reason, breach: false } };
        }
        throw toolError(`Unknown tool "${request.name}"`, request.name);
      }
      const tool = deps.embedderTools.get(request.name);
      return tool !== undefined ? runEmbedderTool(deps, tool, request) : runCodingTool(deps, request);
    },
  };
}
