/**
 * Public types of the agent session facade (S3 spec section 4). The facade
 * drives the S1 AgentSessionAdapter; nothing here is backend-specific, so the
 * acpx backend (S4) reuses these types unchanged.
 */
import type { CommandInterceptor } from "#src/command-interceptor/index";
import type { BashApprovalMode } from "#src/config/bash-approval";
import type { TokenUsage } from "#src/cost/standard-types";
import type { NativeCatalogOverrides } from "#src/native/client";
import type { CredentialSource } from "#src/native/credentials/session-source";
import type { LoopHandlerSet } from "#src/native/session/loop-events/types";
import type { TranscriptStore } from "#src/native/session/transcript-types";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import type { JSONSchema } from "./tool-descriptor.ts";

/**
 * What the session's agent may touch. Capability statements, not tool lists
 * (spec 4.5). `ask`: every mutating action is approved through `answer()`.
 */
export type AgentSessionProfile = "none" | "read" | "ask" | "full";

export interface EmbedderToolContext {
  readonly sessionId: string;
  /** The provider's tool-call id: the same id as the `tool_call` / `tool_result` events. */
  readonly toolCallId: string;
  /** Aborts when the turn is cancelled, times out or the session closes. */
  readonly signal: AbortSignal;
}

export interface EmbedderToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

/** An in-process tool the embedder supplies (spec 4.3). */
export interface EmbedderTool {
  /** The name the model sees. A letter, then letters, digits, `_` or `-`; at most 64 characters. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  /** `always` asks the person through `answer()` before every run. */
  readonly approval: "never" | "always";
  /** The approval summary. Default: the redacted, byte-capped JSON of the input. */
  describe?(input: unknown): string;
  /** A throw, or `isError: true`, reaches the model as an error result. */
  run(input: unknown, ctx: EmbedderToolContext): Promise<EmbedderToolResult>;
}

/** Host ports an embedder may supply (spec 6.2). */
export interface AgentSessionHostPorts {
  /** Paths the sandbox and the read tools deny. Default: the configured credentials directory, if any. */
  readonly protectedPaths?: ProtectedPathsPolicy;
  readonly commandInterceptor?: CommandInterceptor;
}

export interface CreateAgentSessionOptions {
  readonly backend: "native";
  /** The store key. Generated when absent. Letters, digits, `.`, `_`, `-`; starts with a letter or digit; at most 128 characters. */
  readonly sessionId?: string;
  /** `"provider/model"`, optionally with an `[effort]` suffix. */
  readonly model: string;
  readonly profile: AgentSessionProfile;
  /** An absolute directory. Required for `read` and `full`; `none` gets a private temporary root. */
  readonly workdir?: string;
  /** The embedder's system prompt. */
  readonly instructions?: string;
  readonly tools?: readonly EmbedderTool[];
  /**
   * Where the conversation lives. The session keeps its document on close, so
   * `resumeAgentSession` can reopen it. A file store's failed-close prune counts
   * every transcript in its directory, so do not share a file-store directory
   * with sessions that are closed as failed.
   */
  readonly transcriptStore: TranscriptStore;
  /** How long an approval or question waits. Default 600000; 30000..3600000. */
  readonly approvalTimeoutMs?: number;
  /** `full` only. Default `"gated"`. */
  readonly bashApproval?: BashApprovalMode;
  /** `full` only, and only with `bashApproval: "gated"`: run without a sandbox when none is usable. */
  readonly allowUnsandboxed?: boolean;
  /** Falls back to the `configureCredentials` slot when absent. */
  readonly credentials?: CredentialSource;
  readonly catalogOverrides?: NativeCatalogOverrides;
  readonly loopHandlers?: LoopHandlerSet;
  readonly hostPorts?: AgentSessionHostPorts;
  /** Copied onto every event. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Per-turn wall clock. Default 3600; 1..86400. */
  readonly turnTimeoutSeconds?: number;
}

export type TurnEndStatus = "completed" | "cancelled" | "timed_out" | "interrupted" | "errored";

export type ApprovalDecidedBy = "human" | "timeout" | "cancelled" | "unavailable" | "unshowable" | "profile";

/**
 * How a turn's `costUsd` was obtained (S4 spec 5.5). Absent means `computed`
 * from the catalog (the native backend). `unpriced` rows carry `costUsd: 0`
 * and must not be summed as a real cost.
 */
export type CostSource = "computed" | "reported" | "unpriced";

export interface SessionEventBase {
  readonly sessionId: string;
  readonly turnId: string;
  /** ISO 8601. */
  readonly at: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type SessionEventBody =
  | { readonly type: "turn_start" }
  | { readonly type: "text_delta"; readonly round: number; readonly text: string }
  | { readonly type: "thinking_delta"; readonly round: number; readonly text: string }
  | { readonly type: "stream_reset"; readonly round: number; readonly attempt: number }
  | { readonly type: "tool_call"; readonly callId: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly callId: string; readonly isError: boolean; readonly preview: string }
  | {
      readonly type: "approval_requested";
      readonly requestId: string;
      readonly callId?: string;
      readonly tool: string;
      readonly summary: string;
      readonly command?: string;
      readonly reason: string;
      readonly expiresAt: string;
    }
  | {
      readonly type: "approval_resolved";
      readonly requestId: string;
      readonly decision: "allow" | "deny";
      readonly decidedBy: ApprovalDecidedBy;
    }
  | { readonly type: "question"; readonly requestId: string; readonly text: string; readonly expiresAt: string }
  | {
      readonly type: "usage";
      readonly round: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
      readonly costUsd: number;
      readonly costSource?: CostSource;
    }
  | { readonly type: "compaction"; readonly reason: "proactive" | "overflow" }
  | {
      readonly type: "turn_end";
      readonly status: TurnEndStatus;
      /** The final round's text, as `TurnResult.output`. Empty when the turn did not complete. */
      readonly output: string;
      readonly usage: TokenUsage;
      readonly costUsd: number;
      readonly costSource?: CostSource;
      readonly error?: { readonly code: string; readonly message: string };
    };

/**
 * One event of a `send()` (spec 4.4). Deltas are provisional: the transcript
 * and `turn_end.output` are authoritative. `turn_end` is always last.
 */
export type SessionEvent = SessionEventBase & SessionEventBody;

export type AnswerReply = { readonly decision: "allow" | "deny" } | { readonly text: string };

export type AnswerStatus = "accepted" | "expired" | "cancelled" | "unknown";

export interface AgentSession {
  readonly id: string;
  /** Set after each `turn_end`; on resume, `interrupted` when a dead process left a turn running. Undefined otherwise. */
  readonly lastTurn: { readonly turnId: string; readonly status: TurnEndStatus } | undefined;
  /** Claims the session's single turn slot synchronously; the turn starts on the first `next()`. */
  send(message: string): AsyncIterable<SessionEvent>;
  answer(requestId: string, reply: AnswerReply): AnswerStatus;
  /** Aborts the running turn; a no-op when none runs. */
  cancel(reason?: string): void;
  /** Idempotent. Cancels a running turn, waits for it, keeps the document in the store. */
  close(): Promise<void>;
}
