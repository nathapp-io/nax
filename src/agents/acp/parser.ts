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

/** Mutable accumulator for incremental NDJSON line parsing. */
export interface AcpxParseState {
  text: string;
  tokenUsage: AcpxTokenUsage | undefined;
  exactCostUsd: number | undefined;
  stopReason: string | undefined;
  error: string | undefined;
  /** True if the acpx error response explicitly set retryable=true (e.g. QUEUE_DISCONNECTED). */
  retryable: boolean;
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
  };
}

/**
 * Process a single NDJSON line into the accumulator state.
 * Handles JSON-RPC envelope format (acpx v0.3+) and legacy flat NDJSON.
 */
export function parseAcpxJsonLine(line: string, state: AcpxParseState): void {
  try {
    const event = JSON.parse(line);

    // ── JSON-RPC envelope format (acpx v0.3+) ──────────────────────────────
    if (event.jsonrpc === "2.0") {
      if (event.method === "session/update" && event.params?.update) {
        const update = event.params.update;

        // Text chunks
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && update.content.text) {
          state.text += update.content.text;
        }

        // Exact cost from usage_update
        if (update.sessionUpdate === "usage_update" && typeof update.cost?.amount === "number") {
          state.exactCostUsd = update.cost.amount;
        }
      }

      // Final result with token breakdown
      if (event.id !== undefined && event.result && typeof event.result === "object") {
        const result = event.result as Record<string, unknown>;

        if (result.stopReason) state.stopReason = result.stopReason as string;
        if (result.stop_reason) state.stopReason = result.stop_reason as string;

        if (result.usage && typeof result.usage === "object") {
          const u = result.usage as Record<string, unknown>;
          state.tokenUsage = {
            input_tokens: (u.inputTokens as number) ?? (u.input_tokens as number) ?? 0,
            output_tokens: (u.outputTokens as number) ?? (u.output_tokens as number) ?? 0,
            cache_read_input_tokens: (u.cachedReadTokens as number) ?? (u.cache_read_input_tokens as number) ?? 0,
            cache_creation_input_tokens:
              (u.cachedWriteTokens as number) ?? (u.cache_creation_input_tokens as number) ?? 0,
          };
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

      return;
    }

    // ── Legacy flat NDJSON format ───────────────────────────────────────────
    if (event.content && typeof event.content === "string") state.text += event.content;
    if (event.text && typeof event.text === "string") state.text += event.text;
    if (event.result && typeof event.result === "string") state.text = event.result;

    if (event.cumulative_token_usage) state.tokenUsage = event.cumulative_token_usage;
    if (event.usage) {
      state.tokenUsage = {
        input_tokens: event.usage.input_tokens ?? event.usage.prompt_tokens ?? 0,
        output_tokens: event.usage.output_tokens ?? event.usage.completion_tokens ?? 0,
      };
    }

    if (event.stopReason) state.stopReason = event.stopReason;
    if (event.stop_reason) state.stopReason = event.stop_reason;
    if (event.error) {
      state.error =
        typeof event.error === "string" ? event.error : (event.error.message ?? JSON.stringify(event.error));
    }
  } catch {
    if (!state.text) state.text = line;
  }
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
