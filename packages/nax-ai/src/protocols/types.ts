/**
 * Wire-protocol vocabulary.
 *
 * Every concept here appears in more than one provider's wire format, or is a
 * deliberate normalisation. No field is named after one provider's API: the
 * point of this file is that a backend for any provider can be written against
 * it without the interface having already picked a side.
 */

import type { StopReason, TokenUsage } from "../types.ts";

/** JSON Schema draft 2020-12 object. Structural — nax-ai does not validate it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * Ascending order is load-bearing: clamping an unsupported level picks the
 * nearest supported one by index, so reordering this array changes behaviour.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const CACHE_RETENTIONS = ["none", "short", "long"] as const;
export type CacheRetention = (typeof CACHE_RETENTIONS)[number];

export const PROTOCOL_EVENT_TYPES = [
  "text-delta",
  "thinking-delta",
  "tool-call-partial",
  "tool-call",
  "usage",
  "error",
  "done",
] as const;
export type ProtocolEventType = (typeof PROTOCOL_EVENT_TYPES)[number];

export const PROTOCOL_ERROR_KINDS = [
  "rate-limit",
  "auth",
  "overloaded",
  "bad-request",
  "transport",
  "unknown",
] as const;
export type ProtocolErrorKind = (typeof PROTOCOL_ERROR_KINDS)[number];

export interface ProtocolError {
  readonly kind: ProtocolErrorKind;
  readonly message: string;
  readonly status?: number;
  /** Seconds, when the provider signals one. The consumer owns the retry loop. */
  readonly retryAfter?: number;
  readonly cause?: unknown;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Parsed. A protocol accumulates streamed JSON fragments and parses before emitting. */
  readonly input: unknown;
}

export type ConversationMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: "tool-result";
      readonly toolCallId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export interface ProtocolRequest {
  readonly model: string;
  /**
   * The model's owning provider, supplied by the client so a protocol can
   * scope model resolution when ids are ambiguous across providers.
   */
  readonly provider?: string;
  /**
   * Kept out of `messages` deliberately: Anthropic takes a top-level `system`
   * parameter while OpenAI takes a system message in the array. Each backend
   * places it correctly, so callers never encode a provider's shape.
   */
  readonly system?: string;
  readonly messages: readonly ConversationMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: "auto" | "none";
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly thinking?: ThinkingLevel;
  readonly cacheRetention?: CacheRetention;
  readonly signal?: AbortSignal;
}

export type ProtocolEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "thinking-delta"; readonly text: string }
  | {
      readonly type: "tool-call-partial";
      readonly id: string;
      readonly name: string;
      /** Raw accumulated JSON fragment — for progress display only. */
      readonly rawInput: string;
    }
  | { readonly type: "tool-call"; readonly call: ToolCall }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "error"; readonly error: ProtocolError }
  | { readonly type: "done"; readonly stopReason: StopReason };

/**
 * A wire protocol.
 *
 * `complete` is deliberately absent. It is derived once, at the client layer,
 * by collecting a stream — so a backend has no way to implement it as a second
 * request path that drifts from this one.
 */
export interface Protocol {
  readonly name: string;
  stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent>;
}
