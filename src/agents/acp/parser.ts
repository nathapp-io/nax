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
            const inp = metaUsage.inputTokens ?? metaUsage.input_tokens;
            if (typeof inp === "number") activity.inputTokens = inp;
            const out = metaUsage.outputTokens ?? metaUsage.output_tokens;
            if (typeof out === "number") activity.outputTokens = out;
          }
          // Fall back to update.used for output tokens if breakdown was absent
          if (activity.outputTokens == null && typeof update.used === "number") {
            activity.outputTokens = update.used;
          }
          // Extract cost if available
          if (typeof (update.cost as Record<string, unknown> | undefined)?.amount === "number") {
            activity.costUsd = (update.cost as Record<string, unknown>).amount as number;
            state.exactCostUsd = activity.costUsd;
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
          const asNumber = (...values: unknown[]): number => {
            for (const v of values) {
              if (typeof v === "number" && Number.isFinite(v)) return v;
            }
            return 0;
          };
          state.tokenUsage = {
            input_tokens: asNumber(u.inputTokens, u.input_tokens),
            output_tokens: asNumber(u.outputTokens, u.output_tokens),
            cache_read_input_tokens: asNumber(u.cachedReadTokens, u.cache_read_input_tokens),
            cache_creation_input_tokens: asNumber(u.cachedWriteTokens, u.cache_creation_input_tokens),
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
