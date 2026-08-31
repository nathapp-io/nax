/**
 * OpenAI Completions, backed by pi-ai. Serves openrouter, deepseek and groq.
 *
 * Deliberately duplicates the shape of the anthropic-messages backend rather
 * than sharing it: the two are independent wire formats, and this file must be
 * replaceable on its own by a hand-written implementation.
 *
 * pi-ai types must not escape this file.
 */

import { toTokenUsage } from "../../usage.ts";
import type { Protocol, ProtocolEvent, ProtocolRequest, ToolCall } from "../types.ts";

export type PiStreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-partial"; id: string; name: string; argsFragment: string }
  | { type: "tool-end"; id: string; name: string }
  | { type: "usage"; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }
  | { type: "done"; stopReason: "stop" | "length" | "tool_use" | "content_filter" }
  | { type: "error"; message: string; status?: number; retryAfter?: number };

export interface PiClientPort {
  stream(request: unknown): AsyncIterable<PiStreamEvent>;
}

export interface PiDeps {
  readonly client: PiClientPort;
}

export function createOpenAiCodexResponsesPi(deps: PiDeps): Protocol {
  return {
    name: "openai-codex-responses",

    async *stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent> {
      // This wire format takes the system prompt as `instructions`, not as a
      // message in the array.
      const wireRequest = {
        model: req.model,
        ...(req.system !== undefined ? { instructions: req.system } : {}),
        messages: req.messages,
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.thinking !== undefined ? { thinking: req.thinking } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      };

      const pending = new Map<string, { name: string; raw: string }>();

      for await (const event of deps.client.stream(wireRequest)) {
        switch (event.type) {
          case "text":
            yield { type: "text-delta", text: event.text };
            break;

          case "thinking":
            yield { type: "thinking-delta", text: event.text };
            break;

          case "tool-partial": {
            const current = pending.get(event.id) ?? { name: event.name, raw: "" };
            current.raw += event.argsFragment;
            pending.set(event.id, current);
            yield {
              type: "tool-call-partial",
              id: event.id,
              name: event.name,
              rawInput: current.raw,
            };
            break;
          }

          case "tool-end": {
            const current = pending.get(event.id);
            pending.delete(event.id);
            const raw = current?.raw ?? "";
            let input: unknown;
            try {
              input = raw === "" ? {} : JSON.parse(raw);
            } catch (cause) {
              yield {
                type: "error",
                error: {
                  kind: "bad-request",
                  message: `Tool "${event.name}" returned unparseable arguments.`,
                  cause,
                },
              };
              return;
            }
            const call: ToolCall = { id: event.id, name: event.name, input };
            yield { type: "tool-call", call };
            break;
          }

          case "usage":
            yield { type: "usage", usage: toTokenUsage(event.usage) };
            break;

          case "error":
            yield {
              type: "error",
              error: {
                kind: classify(event.status),
                message: event.message,
                ...(event.status !== undefined ? { status: event.status } : {}),
                ...(event.retryAfter !== undefined ? { retryAfter: event.retryAfter } : {}),
              },
            };
            return;

          case "done":
            yield { type: "done", stopReason: event.stopReason };
            return;
        }
      }
    },
  };
}

function classify(
  status: number | undefined,
): "rate-limit" | "auth" | "overloaded" | "bad-request" | "transport" | "unknown" {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 400 && status < 500) return "bad-request";
  if (status >= 500) return "transport";
  return "unknown";
}
