/**
 * Public vocabulary for nax-ai.
 *
 * These types are deliberately generic. nax-ai knows nothing about stories,
 * operations, sessions or permissions — a consumer maps these onto its own
 * domain at its own boundary. Keeping nax concepts out of this file is what
 * makes the package reusable; see ADR note in README.
 */

/** Provider identifier as understood by the underlying client (e.g. "anthropic"). */
export type ProviderId = string;

/** A model selector: provider plus the provider's own model id. */
export interface ModelRef {
  readonly provider: ProviderId;
  readonly model: string;
}

/** Role of a message in a conversation. */
export type MessageRole = "system" | "user" | "assistant";

export interface Message {
  readonly role: MessageRole;
  readonly content: string;
}

/**
 * Token accounting for a single call.
 *
 * Cache fields are separate rather than folded into `input` because providers
 * price cache reads and cache writes differently, and a consumer computing
 * cost needs them apart. Absent means the provider did not report it — which
 * is different from zero.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Why the provider stopped generating. */
export type StopReason = "stop" | "length" | "tool_use" | "content_filter" | "error";

export interface CompleteOptions {
  readonly model: ModelRef;
  readonly messages: readonly Message[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface CompleteResult {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly stopReason: StopReason;
  readonly toolCalls?: readonly import("./protocols/types.ts").ToolCall[];
}

/**
 * Persistent credential storage, injected by the consumer.
 *
 * `modify` is a read-modify-write hook rather than a plain `write` so an
 * implementation can hold a lock across the whole operation. That matters for
 * OAuth refresh: concurrent processes sharing one credential file will
 * otherwise race, and the in-process serialisation the default store provides
 * does not span processes.
 */
export interface CredentialStore {
  read(providerId: ProviderId): Promise<StoredCredential | undefined>;
  modify(
    providerId: ProviderId,
    fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
  ): Promise<StoredCredential | undefined>;
  delete(providerId: ProviderId): Promise<void>;
}

export type StoredCredential =
  | { readonly kind: "api-key"; readonly key: string }
  | {
      readonly kind: "oauth";
      readonly access: string;
      readonly refresh: string;
      /** Epoch milliseconds. */
      readonly expires: number;
    };
