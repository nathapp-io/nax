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
): Promise<{ text: string; tokenUsage?: AcpxTokenUsage }> {
  let accumulatedText = "";
  let tokenUsage: AcpxTokenUsage | undefined;
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

          if (update.sessionUpdate === "usage_update" && update.used !== undefined) {
            const total = update.used;
            tokenUsage = {
              input_tokens: Math.floor(total * 0.3),
              output_tokens: Math.floor(total * 0.7),
            };
          }
        }

        if (msg.result) {
          const result = msg.result as Record<string, unknown>;
          if (typeof result === "string") {
            accumulatedText += result;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: accumulatedText.trim(), tokenUsage };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseAcpxJsonOutput
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse acpx NDJSON output for assistant text and token usage.
 */
export function parseAcpxJsonOutput(rawOutput: string): {
  text: string;
  tokenUsage?: AcpxTokenUsage;
  stopReason?: string;
  error?: string;
} {
  const lines = rawOutput.split("\n").filter((l) => l.trim());
  let text = "";
  let tokenUsage: AcpxTokenUsage | undefined;
  let stopReason: string | undefined;
  let error: string | undefined;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

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

  return { text: text.trim(), tokenUsage, stopReason, error };
}
