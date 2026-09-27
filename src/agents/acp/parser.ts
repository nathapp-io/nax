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
 *
 * parseAcpxJsonLine is a sequencer: parse the line, purge any legacy-text
 * fallback on the first NDJSON line, apply the BUG-53 protocol-drift guard,
 * then dispatch to the per-branch handlers in ./parser-line-handlers (the
 * JSON-RPC envelope path, the legacy flat-NDJSON path) which mutate the
 * accumulator state in place.
 */

import { handleJsonRpcEvent, handleLegacyLine, isProtocolDrift, reportProtocolDrift } from "./parser-line-handlers";

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
  /** Cache-read tokens the provider served from its prompt cache. Absent when
   *  the wire reported none — never coerced to 0, so "no cache data" and
   *  "zero cache tokens" stay distinguishable. */
  cacheRead?: number;
  /** Cache-creation (write) tokens. Absent for the same reason as `cacheRead`. */
  cacheWrite?: number;
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
    if (isProtocolDrift(event)) {
      reportProtocolDrift(event, state);
      return undefined;
    }

    // ── JSON-RPC envelope format (acpx v0.3+) ──────────────────────────────
    if (event.jsonrpc === "2.0") {
      return handleJsonRpcEvent(event, state);
    }

    // ── Legacy flat NDJSON format ───────────────────────────────────────────
    handleLegacyLine(event, state);
  } catch {
    // Only treat an unparseable line as legacy plain-text output when no NDJSON
    // line has been seen yet — otherwise a stray banner/reconnect-notice line
    // becomes a permanent prefix of an otherwise-successful JSON-RPC response.
    if (!state.text && !state.sawJsonLine) state.text = line;
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
