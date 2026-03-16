/**
 * ACP adapter — NDJSON and JSON-RPC output parsing helpers.
 *
 * Extracted from adapter.ts to keep that file within the 800-line limit.
 * Used only by _runOnce() (the spawn-based legacy path).
 */

import type { AgentRunOptions } from "../types";

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

/** JSON-RPC message from acpx --format json --json-strict */
interface JsonRpcMessage {
  jsonrpc: "2.0";
  method?: string;
  params?: {
    sessionId: string;
    update?: {
      sessionUpdate: string;
      content?: { type: string; text?: string };
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string };
    };
  };
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// streamJsonRpcEvents
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stream stdout line-by-line, parse JSON-RPC, detect questions, call bridge.
 */
export async function streamJsonRpcEvents(
  stdout: ReadableStream<Uint8Array>,
  bridge: AgentRunOptions["interactionBridge"],
  _sessionId: string,
): Promise<{ text: string; tokenUsage?: AcpxTokenUsage; exactCostUsd?: number }> {
  let accumulatedText = "";
  let tokenUsage: AcpxTokenUsage | undefined;
  let exactCostUsd: number | undefined;
  const decoder = new TextDecoder();
  let buffer = "";

  const reader = stdout.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (msg.method === "session/update" && msg.params?.update) {
          const update = msg.params.update;

          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" &&
            update.content.text
          ) {
            accumulatedText += update.content.text;

            if (bridge?.detectQuestion && bridge.onQuestionDetected) {
              const isQuestion = await bridge.detectQuestion(accumulatedText);
              if (isQuestion) {
                const response = await bridge.onQuestionDetected(accumulatedText);
                accumulatedText += `\n\n[Human response: ${response}]`;
              }
            }
          }

          if (update.sessionUpdate === "usage_update" && typeof update.cost?.amount === "number") {
            exactCostUsd = update.cost.amount;
          }
        }

        if (msg.id !== undefined && msg.result && typeof msg.result === "object") {
          const result = msg.result as Record<string, unknown>;
          if (result.usage && typeof result.usage === "object") {
            const u = result.usage as Record<string, unknown>;
            tokenUsage = {
              input_tokens: (u.inputTokens as number) ?? (u.input_tokens as number) ?? 0,
              output_tokens: (u.outputTokens as number) ?? (u.output_tokens as number) ?? 0,
              cache_read_input_tokens: (u.cachedReadTokens as number) ?? (u.cache_read_input_tokens as number) ?? 0,
              cache_creation_input_tokens:
                (u.cachedWriteTokens as number) ?? (u.cache_creation_input_tokens as number) ?? 0,
            };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: accumulatedText.trim(), tokenUsage, exactCostUsd };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseAcpxJsonOutput
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
} {
  const lines = rawOutput.split("\n").filter((l) => l.trim());
  let text = "";
  let tokenUsage: AcpxTokenUsage | undefined;
  let exactCostUsd: number | undefined;
  let stopReason: string | undefined;
  let error: string | undefined;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // ── JSON-RPC envelope format (acpx v0.3+) ──────────────────────────────
      if (event.jsonrpc === "2.0") {
        // session/update events
        if (event.method === "session/update" && event.params?.update) {
          const update = event.params.update;

          // Text chunks
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" &&
            update.content.text
          ) {
            text += update.content.text;
          }

          // Exact cost from usage_update
          if (update.sessionUpdate === "usage_update" && typeof update.cost?.amount === "number") {
            exactCostUsd = update.cost.amount;
          }
        }

        // Final result with token breakdown (camelCase from acpx)
        if (event.id !== undefined && event.result && typeof event.result === "object") {
          const result = event.result as Record<string, unknown>;

          if (result.stopReason) stopReason = result.stopReason as string;
          if (result.stop_reason) stopReason = result.stop_reason as string;

          if (result.usage && typeof result.usage === "object") {
            const u = result.usage as Record<string, unknown>;
            tokenUsage = {
              input_tokens: (u.inputTokens as number) ?? (u.input_tokens as number) ?? 0,
              output_tokens: (u.outputTokens as number) ?? (u.output_tokens as number) ?? 0,
              cache_read_input_tokens: (u.cachedReadTokens as number) ?? (u.cache_read_input_tokens as number) ?? 0,
              cache_creation_input_tokens:
                (u.cachedWriteTokens as number) ?? (u.cache_creation_input_tokens as number) ?? 0,
            };
          }
        }

        continue;
      }

      // ── Legacy flat NDJSON format ───────────────────────────────────────────
      if (event.content && typeof event.content === "string") text += event.content;
      if (event.text && typeof event.text === "string") text += event.text;
      if (event.result && typeof event.result === "string") text = event.result;

      if (event.cumulative_token_usage) tokenUsage = event.cumulative_token_usage;
      if (event.usage) {
        tokenUsage = {
          input_tokens: event.usage.input_tokens ?? event.usage.prompt_tokens ?? 0,
          output_tokens: event.usage.output_tokens ?? event.usage.completion_tokens ?? 0,
        };
      }

      if (event.stopReason) stopReason = event.stopReason;
      if (event.stop_reason) stopReason = event.stop_reason;
      if (event.error) {
        error = typeof event.error === "string" ? event.error : (event.error.message ?? JSON.stringify(event.error));
      }
    } catch {
      if (!text) text = line;
    }
  }

  return { text: text.trim(), tokenUsage, exactCostUsd, stopReason, error };
}
