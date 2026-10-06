/**
 * The backend seam (S4 spec §5.1). A `SessionBackend` opens an
 * `OpenedBackend`: the S1 `AgentSessionAdapter` plus the per-turn options it
 * contributes, the ask port it reaches the facade through, and the info the
 * facade records. The native backend and the out-of-tree ACP backend both
 * satisfy this contract; nothing here is backend-specific.
 */
import type { TranscriptDoc, TranscriptStore } from "#src/native/session/transcript-types";
import type { AgentSessionProfile, ApprovalDecidedBy, EmbedderTool } from "./agent-session-types.ts";
import type { AgentSessionAdapter, SendTurnOpts, SessionHandle } from "./session-types.ts";

export interface BackendInfo {
  /** "native" or "acp:<agent>"; recorded in the transcript document. */
  readonly kind: string;
  /** Read-only, JSON-safe capability summary. `{}` for native. */
  readonly capabilities: Readonly<Record<string, unknown>>;
}

export interface ApprovalRequest {
  readonly callId?: string;
  readonly tool: string;
  readonly summary: string;
  readonly command?: string;
  readonly reason: string;
  /** Extra abort source, combined with the turn signal (for example a tool-level abort). */
  readonly signal?: AbortSignal;
}

export interface SessionAskPort {
  /** Throws NaxError AGENT_SESSION_TURN_FAILED (context.detail "no-turn") when no turn is running. */
  requestApproval(
    req: ApprovalRequest,
  ): Promise<{ readonly decision: "allow" | "deny"; readonly decidedBy: ApprovalDecidedBy }>;
  /** Emits approval_requested then approval_resolved (decidedBy "profile"). No-op when no turn is running. */
  recordAutoDecision(req: Omit<ApprovalRequest, "command" | "signal">, decision: "allow" | "deny"): void;
  /**
   * The person's text, or null on deadline, cancel or no running turn. `opts.signal`
   * is an extra abort source combined with the turn signal, as for approvals (for
   * example a backend's per-request scope that ends before the turn does).
   */
  askQuestion(text: string, opts?: { readonly signal?: AbortSignal }): Promise<string | null>;
  /** An informational question event; answer() on its id returns "cancelled". No-op when no turn is running. */
  noteQuestion(text: string): void;
}

/** What a backend contributes to every sendTurn. */
export type TurnContribution = Pick<SendTurnOpts, "interactionHandler"> &
  Partial<Pick<SendTurnOpts, "codingTools" | "loopHandlers" | "loopHandlerContext">>;

export interface BackendOpenContext {
  readonly sessionId: string;
  /** The facade's resolved root: the workdir, or a private scratch root for profile "none". */
  readonly workdir: string;
  readonly profile: AgentSessionProfile;
  readonly instructions: string | undefined;
  readonly tools: readonly EmbedderTool[];
  readonly transcriptStore: TranscriptStore;
  /** The stored document on resume (already presence-, schema- and kind-checked by the facade). */
  readonly resume: { readonly doc: TranscriptDoc } | undefined;
  readonly asks: SessionAskPort;
  /** Re-read at use time: the running turn's signal, or a never-aborting one between turns. */
  readonly turnSignal: () => AbortSignal;
  readonly currentTurnId: () => string | undefined;
  readonly turnTimeoutSeconds: number;
  readonly metadata: Readonly<Record<string, string>>;
  /** Aborted when the session starts closing. */
  readonly openSignal: AbortSignal;
}

export interface OpenedBackend {
  readonly adapter: AgentSessionAdapter;
  readonly handle: SessionHandle;
  readonly info: BackendInfo;
  turnOpts(): TurnContribution;
  /** Releases backend resources after adapter.closeSession. Idempotent. */
  close(): Promise<void>;
}

export interface SessionBackend {
  readonly kind: string;
  open(ctx: BackendOpenContext): Promise<OpenedBackend>;
}
