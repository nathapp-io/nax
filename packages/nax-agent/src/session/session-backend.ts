/**
 * The backend seam (S4 spec §5.1). A `SessionBackend` opens an
 * `OpenedBackend`: the S1 `AgentSessionAdapter` plus the per-turn options it
 * contributes, the ask port it reaches the facade through, and the info the
 * facade records. The native backend and the out-of-tree ACP backend both
 * satisfy this contract; nothing here is backend-specific.
 */
import type { TranscriptDoc, TranscriptStore } from "#src/native/session/transcript-types";
import type { SandboxState } from "#src/sandbox/types";
import type {
  AgentSessionProfile,
  ApprovalDecidedBy,
  CommandRunResult,
  EmbedderTool,
  SessionConfigureInput,
} from "./agent-session-types.ts";
import type { AgentSessionAdapter, SendTurnOpts, SessionHandle } from "./session-types.ts";

export interface BackendInfo {
  /** "native" or "acp:<agent>"; recorded in the transcript document. */
  readonly kind: string;
  /** Read-only, JSON-safe capability summary. `{}` for native. */
  readonly capabilities: Readonly<Record<string, unknown>>;
  /**
   * US-001: the sandbox this backend resolved when it opened, so the embedder can
   * say what the session's commands actually run under. Reported once at open — a
   * sandbox that stops working mid-session is not re-probed. Absent for a backend
   * that runs no shell of its own (the ACP backend leaves it out).
   */
  readonly sandbox?: SandboxState;
}

export interface ApprovalRequest {
  readonly callId?: string;
  readonly tool: string;
  readonly summary: string;
  readonly command?: string;
  readonly reason: string;
  /**
   * US-004: the ask is for a run OUTSIDE the OS sandbox. Copied from the
   * `AskRequest` by `createSessionAskLink` and forwarded onto the
   * `approval_requested` event by `askPerson`; absent on every ordinary ask.
   */
  readonly unsandboxed?: true;
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
  /** nax#2500: present only for profiles review/full when the embedder supplied one. */
  readonly sandbox?: import("#src/sandbox/types").SessionSandbox;
  /**
   * The rendered `## MCP servers` section for this open (#2517). The ACP
   * backend (nax-agent-acp) offers it to its tool host, so the agent's own MCP
   * client receives it in `initialize`; the native backend leaves it alone —
   * native reaches the same text through `OpenSessionOpts.providerInstructions`.
   */
  readonly providerInstructions?: string;
}

export interface OpenedBackend {
  /** Absent on a backend that cannot receive image input. Re-read the current model/agent on each query. */
  acceptsImages?(): Promise<boolean>;
  /** Absent on a backend that cannot change model or effort on a live session. The facade validates `input` first. */
  configure?(input: SessionConfigureInput): Promise<void>;
  /** Absent on a backend that cannot run a host-side command (ACP). */
  runCommand?(request: { command: string; callId: string; signal: AbortSignal }): Promise<CommandRunResult>;
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
