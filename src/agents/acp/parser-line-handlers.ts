/**
 * ACP adapter — per-event handlers for parseAcpxJsonLine (parser.ts).
 *
 * Split out of parser.ts by the B3 complexity drain. parseAcpxJsonLine stays
 * in parser.ts as the sequencer (parse → sawJsonLine purge → drift guard →
 * JSON-RPC vs legacy dispatch); this file holds the per-branch handlers:
 *
 * - Drift guard (BUG-53): isProtocolDrift / reportProtocolDrift
 * - JSON-RPC envelope (acpx v0.3+): handleJsonRpcEvent — a dispatch map on
 *   `update.sessionUpdate` routes session/update events to their handler;
 *   everything else falls through to the result/error appliers
 * - Legacy flat NDJSON: handleLegacyLine — one applier per field group
 *
 * Handlers MUTATE the caller's AcpxParseState in place (the accumulator is
 * shared across lines by design) and return activity metadata where the wire
 * carries a stream event. Comments moved verbatim with their code.
 */

import { getSafeLogger } from "@/logger";
import type { AcpxLineActivity, AcpxParseState } from "./parser";

/**
 * One parsed NDJSON line. Typed via JSON.parse's own return type on purpose:
 * the wire is untrusted and arbitrarily shaped, and every access below is a
 * runtime-guarded dynamic read exactly as before the split — a structural
 * type would just push guards into casts without making anything safer.
 */
type ParsedJson = ReturnType<typeof JSON.parse>;

/** Return the first of several candidates that is a finite number, else undefined. */
function asFiniteNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

// ── Protocol-version drift guard (BUG-53) ──────────────────────────────
// A message shaped like JSON-RPC (has method+params, or id with an
// object result) but with a missing/mismatched jsonrpc field must not
// silently fall into the legacy flat-NDJSON branch below — that branch
// expects a *string* result and would drop an object-valued one outright.
// Treat it as an unsupported protocol version instead of misparsing it.
//
// An object-valued `error` is deliberately NOT part of this test: the
// legacy branch handles that shape correctly (it reads `event.error.message`,
// see below), so including it stole a representable shape and replaced the
// agent's real failure reason with a bogus protocol message — destroying
// the only diagnostic the caller had. A genuinely drifted JSON-RPC error
// response falls through to the same legacy handler and still surfaces its
// message, so nothing is lost by narrowing this.
export function isProtocolDrift(event: ParsedJson): boolean {
  const looksLikeJsonRpcShape =
    (typeof event.method === "string" && event.params !== undefined) ||
    (event.id !== undefined && event.result && typeof event.result === "object");

  return event.jsonrpc !== "2.0" && looksLikeJsonRpcShape;
}

export function reportProtocolDrift(event: ParsedJson, state: AcpxParseState): void {
  getSafeLogger()?.error("acp-adapter", "Unsupported or missing JSON-RPC protocol version in acpx output", {
    jsonrpc: event.jsonrpc,
    method: typeof event.method === "string" ? event.method : undefined,
  });
  // Surface the drift on state.error — otherwise the caller sees
  // {text: "", error: undefined} and reports a successful empty turn
  // instead of failing on the unsupported protocol version.
  state.error ??= "Unsupported acpx JSON-RPC protocol version";
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC envelope format (acpx v0.3+)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared error diagnostics for both error branches (byte-identical logic in
 * the pre-split parser): append acpxCode/detailCode from data for richer
 * context, and respect the retryable flag — first error wins.
 */
function decorateAcpxError(err: ParsedJson, errorMsg: string, state: AcpxParseState): string {
  let msg = errorMsg;
  const data = err.data;
  if (data && typeof data === "object") {
    const suffix = [data.acpxCode, data.detailCode].filter(Boolean).join("/");
    if (suffix) msg = `${msg} [${suffix}]`;
    if (!state.error && data.retryable === true) state.retryable = true;
  }
  return msg;
}

// Text chunks — emit activity metadata without raw content
function handleAgentMessageChunk(update: ParsedJson, state: AcpxParseState): AcpxLineActivity | undefined {
  if (update.content?.type === "text" && typeof update.content.text === "string") {
    const text = update.content.text;
    state.text += text;
    // Return activity metadata with only deltaBytes (no raw text)
    return {
      kind: "message_update",
      deltaBytes: text.length,
    };
  }
  return undefined;
}

// Thought chunks — emit activity metadata without raw content.
// Thought text is internal reasoning and must NOT accumulate in state.text,
// which becomes the final assistant response returned to callers.
function handleAgentThoughtChunk(update: ParsedJson): AcpxLineActivity | undefined {
  if (update.content?.type === "text" && typeof update.content.text === "string") {
    return {
      kind: "thinking_update",
      deltaBytes: update.content.text.length,
    };
  }
  return undefined;
}

// Usage update — emit activity metadata with token/cost info
function handleUsageUpdate(update: ParsedJson, state: AcpxParseState): AcpxLineActivity {
  const activity: AcpxLineActivity = { kind: "usage_update" };
  // _meta.usage carries the per-turn breakdown (inputTokens, outputTokens) when
  // the agent reports it (Claude Code does; other adapters may omit it).
  const metaUsage =
    update._meta != null && typeof update._meta === "object"
      ? ((update._meta as Record<string, unknown>).usage as Record<string, unknown> | undefined)
      : undefined;
  if (metaUsage != null && typeof metaUsage === "object") {
    const inp = asFiniteNumber(metaUsage.inputTokens, metaUsage.input_tokens);
    if (inp !== undefined) activity.inputTokens = inp;
    const out = asFiniteNumber(metaUsage.outputTokens, metaUsage.output_tokens);
    if (out !== undefined) activity.outputTokens = out;
    // Cache figures ride the same _meta.usage object. Left absent when
    // the wire omits them — the final-result breakdown path below keeps
    // its own `?? 0`, but the activity path must not inherit it.
    const cacheRead = asFiniteNumber(metaUsage.cachedReadTokens, metaUsage.cache_read_input_tokens);
    if (cacheRead !== undefined) activity.cacheRead = cacheRead;
    const cacheWrite = asFiniteNumber(metaUsage.cachedWriteTokens, metaUsage.cache_creation_input_tokens);
    if (cacheWrite !== undefined) activity.cacheWrite = cacheWrite;
  }
  // Fall back to update.used for output tokens if breakdown was absent
  if (activity.outputTokens == null) {
    const used = asFiniteNumber(update.used);
    if (used !== undefined) activity.outputTokens = used;
  }
  // Extract cost if available
  const costAmount = asFiniteNumber((update.cost as Record<string, unknown> | undefined)?.amount);
  if (costAmount !== undefined) {
    activity.costUsd = costAmount;
    state.exactCostUsd = costAmount;
  }
  return activity;
}

function handleToolCallActivity(update: ParsedJson): AcpxLineActivity {
  return {
    kind: "tool_call_update",
    toolName: extractToolName(update),
  };
}

function extractToolName(update: ParsedJson): string | undefined {
  const directName = update.toolName;
  if (typeof directName === "string" && directName.trim()) return directName;
  const nestedTool = update.tool;
  if (nestedTool && typeof nestedTool === "object") {
    const name = (nestedTool as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name;
  }
  return undefined;
}

type SessionUpdateHandler = (update: ParsedJson, state: AcpxParseState) => AcpxLineActivity | undefined;

// Dispatch map from `update.sessionUpdate` to its handler. tool_call and
// tool_call_update share one handler — the pre-split parser treated them
// identically. Lookups are own-property guarded so an untrusted
// sessionUpdate value can never reach an inherited Object.prototype member.
const SESSION_UPDATE_HANDLERS: Record<string, SessionUpdateHandler> = {
  agent_message_chunk: handleAgentMessageChunk,
  agent_thought_chunk: handleAgentThoughtChunk,
  usage_update: handleUsageUpdate,
  tool_call: handleToolCallActivity,
  tool_call_update: handleToolCallActivity,
};

function handleSessionUpdate(update: ParsedJson, state: AcpxParseState): AcpxLineActivity | undefined {
  const key = update.sessionUpdate;
  if (typeof key !== "string") return undefined;
  if (!Object.hasOwn(SESSION_UPDATE_HANDLERS, key)) return undefined;
  return SESSION_UPDATE_HANDLERS[key](update, state);
}

function applyJsonRpcResult(event: ParsedJson, state: AcpxParseState): void {
  // Final result with token breakdown
  if (event.id !== undefined && event.result && typeof event.result === "object") {
    const result = event.result as Record<string, unknown>;

    if (result.stopReason) state.stopReason = result.stopReason as string;
    if (result.stop_reason) state.stopReason = result.stop_reason as string;

    if (result.usage && typeof result.usage === "object") {
      const u = result.usage as Record<string, unknown>;
      const inputTokens = asFiniteNumber(u.inputTokens, u.input_tokens);
      const outputTokens = asFiniteNumber(u.outputTokens, u.output_tokens);
      // BUG-54: a partial usage object (missing the required token
      // counts) must not fabricate a zero-filled record — that makes a
      // genuinely free/zero-usage call indistinguishable from a call
      // where usage reporting was simply incomplete. Only accept the
      // record when both required fields are present; cache fields
      // remain optional (default to 0 when absent).
      if (inputTokens !== undefined && outputTokens !== undefined) {
        state.tokenUsage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: asFiniteNumber(u.cachedReadTokens, u.cache_read_input_tokens) ?? 0,
          cache_creation_input_tokens: asFiniteNumber(u.cachedWriteTokens, u.cache_creation_input_tokens) ?? 0,
        };
      }
    }
  }
}

function applyJsonRpcError(event: ParsedJson, state: AcpxParseState): void {
  // JSON-RPC error response — capture the actual failure reason from acpx/codex
  if (event.error && typeof event.error === "object") {
    const err = event.error as Record<string, unknown>;
    let errorMsg = typeof err.message === "string" ? err.message : JSON.stringify(event.error);
    errorMsg = decorateAcpxError(err, errorMsg, state);
    // First error wins — preserves the root cause if acpx emits a cascade of errors
    if (!state.error) state.error = errorMsg;
  }
}

/**
 * Handle one line already known to carry `jsonrpc: "2.0"`. A recognized
 * session/update stream event returns its activity; everything else (an
 * unrecognized update, a final result, an error response) falls through to
 * the result/error appliers and yields undefined — exactly the fall-through
 * structure of the pre-split if-chain.
 */
export function handleJsonRpcEvent(event: ParsedJson, state: AcpxParseState): AcpxLineActivity | undefined {
  if (event.method === "session/update" && event.params?.update) {
    const activity = handleSessionUpdate(event.params.update, state);
    if (activity !== undefined) return activity;
  }
  applyJsonRpcResult(event, state);
  applyJsonRpcError(event, state);
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy flat NDJSON format
// ─────────────────────────────────────────────────────────────────────────────

function applyLegacyCumulativeUsage(event: ParsedJson, state: AcpxParseState): void {
  if (event.cumulative_token_usage && typeof event.cumulative_token_usage === "object") {
    const c = event.cumulative_token_usage as Record<string, unknown>;
    const inputTokens = asFiniteNumber(c.input_tokens);
    const outputTokens = asFiniteNumber(c.output_tokens);
    // BUG-10: same "don't fabricate" rule as BUG-54 below, applied to
    // invalid (not just missing) required fields — a malformed wire value
    // (e.g. a stringified number) must not be assigned as-is. Left
    // unvalidated, it flows through toInternal()'s `?? 0` (which only
    // guards undefined/null) and into addTokenUsage()'s `+`, silently
    // string-concatenating instead of summing.
    if (inputTokens !== undefined && outputTokens !== undefined) {
      state.tokenUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: asFiniteNumber(c.cache_read_input_tokens) ?? 0,
        cache_creation_input_tokens: asFiniteNumber(c.cache_creation_input_tokens) ?? 0,
      };
    }
  }
}

function applyLegacyUsage(event: ParsedJson, state: AcpxParseState): void {
  if (!event.usage) return;
  // BUG-59: use the module's own asFiniteNumber helper instead of a bare
  // `typeof x === "number"` check — Infinity/-Infinity are `typeof number`
  // but not finite, and would otherwise pass through uncaught at this
  // layer (defense in depth; the mapper's own guard would also catch it
  // downstream, but this keeps the parser consistent with every other
  // branch in this file).
  const legacyInputTokens = asFiniteNumber(event.usage.input_tokens, event.usage.prompt_tokens);
  const legacyOutputTokens = asFiniteNumber(event.usage.output_tokens, event.usage.completion_tokens);
  // BUG-54: same rule as the JSON-RPC branch above — don't fabricate a
  // zero-filled usage record when the required fields are missing.
  if (legacyInputTokens !== undefined && legacyOutputTokens !== undefined) {
    state.tokenUsage = {
      input_tokens: legacyInputTokens,
      output_tokens: legacyOutputTokens,
    };
  }
}

function applyLegacyStopReason(event: ParsedJson, state: AcpxParseState): void {
  if (event.stopReason) state.stopReason = event.stopReason;
  if (event.stop_reason) state.stopReason = event.stop_reason;
}

function applyLegacyError(event: ParsedJson, state: AcpxParseState): void {
  if (!event.error) return;
  if (typeof event.error === "string") {
    state.error ??= event.error;
    return;
  }
  // Mirror the JSON-RPC branch's diagnostics. Narrowing the drift guard
  // routed id-bearing error responses here, and `retryable` is not
  // cosmetic — adapter.ts and spawn-client.ts read it to decide whether a
  // failure is retriable, so dropping it would classify a recoverable
  // QUEUE_DISCONNECTED as terminal.
  let errorMsg = typeof event.error.message === "string" ? event.error.message : JSON.stringify(event.error);
  errorMsg = decorateAcpxError(event.error, errorMsg, state);
  // First error wins, in step with the JSON-RPC branch — preserves the root cause.
  state.error ??= errorMsg;
}

/**
 * Handle one line that did not carry `jsonrpc: "2.0"` (and did not trip the
 * BUG-53 drift guard). Each event carries exactly one of: result (final full
 * text), content (streaming chunk), or text (older streaming chunk name).
 * They are mutually exclusive in the acpx protocol — no single event emits
 * more than one. The else-if chain below is intentional: result wins and
 * resets state.text; content and text are additive but never appear together.
 */
export function handleLegacyLine(event: ParsedJson, state: AcpxParseState): void {
  if (event.result && typeof event.result === "string") {
    state.text = event.result;
  } else if (event.content && typeof event.content === "string") {
    state.text += event.content;
  } else if (event.text && typeof event.text === "string") {
    state.text += event.text;
  }

  applyLegacyCumulativeUsage(event, state);
  applyLegacyUsage(event, state);
  applyLegacyStopReason(event, state);
  applyLegacyError(event, state);
}
