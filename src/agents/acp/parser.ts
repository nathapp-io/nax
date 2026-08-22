/**
 * ACP adapter — NDJSON and JSON-RPC output parsing helpers.
 *
 * Extracted from adapter.ts to keep that file within the 800-line limit.
 * Used by SpawnAcpSession.prompt() to parse acpx stdout.
 *
 * Two APIs are provided:
 * - Incremental: createParseState() + parseAcpxJsonLine() + finalizeParseState()
 *   Used by the line-reader in spawn-client to avoid buffering the full stdout.
 * - Batch: parseAcpxJsonOutput() delegates to the incremental API.
 *   Kept for backward compatibility and direct use in tests.
 */

import { getSafeLogger } from "@/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Token usage from acpx NDJSON events */
export interface AcpxTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Activity metadata from a single parsed line — emitted to stream listeners. */
export interface AcpxLineActivity {
  kind?: "message_update" | "thinking_update" | "usage_update" | "tool_call_update";
  deltaBytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  toolName?: string;
}

/** Mutable accumulator for incremental NDJSON line parsing. */
export interface AcpxParseState {
  text: string;
  tokenUsage: AcpxTokenUsage | undefined;
  exactCostUsd: number | undefined;
  stopReason: string | undefined;
  error: string | undefined;
  /** True if the acpx error response explicitly set retryable=true (e.g. QUEUE_DISCONNECTED). */
  retryable: boolean;
  /** True once at least one line has parsed as valid NDJSON — gates the legacy-text fallback below. */
  sawJsonLine: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental API
// ─────────────────────────────────────────────────────────────────────────────

/** Return the first of several candidates that is a finite number, else undefined. */
function asFiniteNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

export function createParseState(): AcpxParseState {
  return {
    text: "",
    tokenUsage: undefined,
    exactCostUsd: undefined,
    stopReason: undefined,
    error: undefined,
    retryable: false,
    sawJsonLine: false,
  };
}

/**
 * Process a single NDJSON line into the accumulator state.
 * Handles JSON-RPC envelope format (acpx v0.3+) and legacy flat NDJSON.
 * Returns activity metadata if the line contains a stream event
 * (message_update, thinking_update, usage_update, tool_call_update).
 * Activity metadata includes only deltaBytes/tokens/cost — never raw text content.
 */
export function parseAcpxJsonLine(line: string, state: AcpxParseState): AcpxLineActivity | undefined {
  try {
    const event = JSON.parse(line);
    if (!state.sawJsonLine) {
      // First real NDJSON line: drop any legacy-text fallback content an
      // earlier unparseable banner/reconnect-notice line may have stashed in
      // state.text, so it can't become a permanent prefix of the real response.
      state.text = "";
      state.sawJsonLine = true;
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
    const looksLikeJsonRpcShape =
      (typeof event.method === "string" && event.params !== undefined) ||
      (event.id !== undefined && event.result && typeof event.result === "object");

    if (event.jsonrpc !== "2.0" && looksLikeJsonRpcShape) {
      getSafeLogger()?.error("acp-adapter", "Unsupported or missing JSON-RPC protocol version in acpx output", {
        jsonrpc: event.jsonrpc,
        method: typeof event.method === "string" ? event.method : undefined,
      });
      // Surface the drift on state.error — otherwise the caller sees
      // {text: "", error: undefined} and reports a successful empty turn
      // instead of failing on the unsupported protocol version.
      state.error ??= "Unsupported acpx JSON-RPC protocol version";
      return undefined;
    }

    // ── JSON-RPC envelope format (acpx v0.3+) ──────────────────────────────
    if (event.jsonrpc === "2.0") {
      if (event.method === "session/update" && event.params?.update) {
        const update = event.params.update;

        // Text chunks — emit activity metadata without raw content
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text" &&
          typeof update.content.text === "string"
        ) {
          const text = update.content.text;
          state.text += text;
          // Return activity metadata with only deltaBytes (no raw text)
          return {
            kind: "message_update",
            deltaBytes: text.length,
          };
        }

        // Thought chunks — emit activity metadata without raw content.
        // Thought text is internal reasoning and must NOT accumulate in state.text,
        // which becomes the final assistant response returned to callers.
        if (
          update.sessionUpdate === "agent_thought_chunk" &&
          update.content?.type === "text" &&
          typeof update.content.text === "string"
        ) {
          return {
            kind: "thinking_update",
            deltaBytes: update.content.text.length,
          };
        }

        // Usage update — emit activity metadata with token/cost info
        if (update.sessionUpdate === "usage_update") {
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

        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          return {
            kind: "tool_call_update",
            toolName: extractToolName(update),
          };
        }
      }

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

      // JSON-RPC error response — capture the actual failure reason from acpx/codex
      if (event.error && typeof event.error === "object") {
        const err = event.error as Record<string, unknown>;
        let errorMsg = typeof err.message === "string" ? err.message : JSON.stringify(event.error);
        // Append acpxCode/detailCode from data for richer context
        if (err.data && typeof err.data === "object") {
          const data = err.data as Record<string, unknown>;
          const suffix = [data.acpxCode, data.detailCode].filter(Boolean).join("/");
          if (suffix) errorMsg = `${errorMsg} [${suffix}]`;
          // Respect retryable flag — first error wins
          if (!state.error && data.retryable === true) state.retryable = true;
        }
        // First error wins — preserves the root cause if acpx emits a cascade of errors
        if (!state.error) state.error = errorMsg;
      }

      return undefined;
    }

    // ── Legacy flat NDJSON format ───────────────────────────────────────────
    // Each event carries exactly one of: result (final full text), content
    // (streaming chunk), or text (older streaming chunk name). They are
    // mutually exclusive in the acpx protocol — no single event emits more
    // than one. Using else-if is intentional: result wins and resets state.text;
    // content and text are additive but never appear together.
    if (event.result && typeof event.result === "string") {
      state.text = event.result;
    } else if (event.content && typeof event.content === "string") {
      state.text += event.content;
    } else if (event.text && typeof event.text === "string") {
      state.text += event.text;
    }

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
    if (event.usage) {
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

    if (event.stopReason) state.stopReason = event.stopReason;
    if (event.stop_reason) state.stopReason = event.stop_reason;
    if (event.error) {
      if (typeof event.error === "string") {
        state.error ??= event.error;
      } else {
        // Mirror the JSON-RPC branch's diagnostics. Narrowing the drift guard
        // routed id-bearing error responses here, and `retryable` is not
        // cosmetic — adapter.ts and spawn-client.ts read it to decide whether a
        // failure is retriable, so dropping it would classify a recoverable
        // QUEUE_DISCONNECTED as terminal.
        let errorMsg = typeof event.error.message === "string" ? event.error.message : JSON.stringify(event.error);
        const data = event.error.data;
        if (data && typeof data === "object") {
          const suffix = [data.acpxCode, data.detailCode].filter(Boolean).join("/");
          if (suffix) errorMsg = `${errorMsg} [${suffix}]`;
          if (!state.error && data.retryable === true) state.retryable = true;
        }
        // First error wins, as in the JSON-RPC branch — preserves the root cause.
        state.error ??= errorMsg;
      }
    }
  } catch {
    // Only treat an unparseable line as legacy plain-text output when no NDJSON
    // line has been seen yet — otherwise a stray banner/reconnect-notice line
    // becomes a permanent prefix of an otherwise-successful JSON-RPC response.
    if (!state.text && !state.sawJsonLine) state.text = line;
  }
  return undefined;
}

function extractToolName(update: Record<string, unknown>): string | undefined {
  const directName = update.toolName;
  if (typeof directName === "string" && directName.trim()) return directName;
  const nestedTool = update.tool;
  if (nestedTool && typeof nestedTool === "object") {
    const name = (nestedTool as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name;
  }
  return undefined;
}

/** Produce the final parsed result from an accumulated state. */
export function finalizeParseState(state: AcpxParseState): ReturnType<typeof parseAcpxJsonOutput> {
  return {
    text: state.text.trim(),
    tokenUsage: state.tokenUsage,
    exactCostUsd: state.exactCostUsd,
    stopReason: state.stopReason,
    error: state.error,
    retryable: state.retryable,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch API (delegates to incremental)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse acpx NDJSON output for assistant text, token usage, and exact cost.
 *
 * Handles the JSON-RPC envelope format emitted by acpx:
 * - session/update agent_message_chunk → text accumulation
 * - session/update usage_update → exact cost (cost.amount) + context size
 * - id/result → token breakdown (inputTokens, outputTokens, cachedWriteTokens, cachedReadTokens)
 *
 * Also handles legacy flat NDJSON format for backward compatibility.
 */
export function parseAcpxJsonOutput(rawOutput: string): {
  text: string;
  tokenUsage?: AcpxTokenUsage;
  exactCostUsd?: number;
  stopReason?: string;
  error?: string;
  retryable: boolean;
} {
  const state = createParseState();
  for (const line of rawOutput.split("\n")) {
    if (line.trim()) parseAcpxJsonLine(line, state);
  }
  return finalizeParseState(state);
}
