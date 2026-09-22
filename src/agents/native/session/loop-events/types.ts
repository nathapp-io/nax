/**
 * The native session's loop-event map (nax#2151, P3).
 *
 * pi's `before_run`/`before_run_end` are `before_turn`/`before_turn_end` here:
 * `runNativeTurn` is ONE TURN, while a nax "run" holds many stories each
 * holding many turns, and `src/hooks/` already fires genuine run-level events.
 * Keeping the vocabularies disjoint is the same reasoning ADR-030's D11 applied
 * to the bash mode axis.
 *
 * `before_payload`, `before_drive` and `before_navigation` are deliberately
 * absent: the payload is built inside nax-ai behind the import boundary, and
 * nax has no branch navigation.
 */

import type { ThinkingBlock, ToolCall, ToolDefinition } from "@nathapp/nax-ai";
import type { TokenUsage } from "@/agents/cost";
import type { TranscriptMessage as NativeTranscriptMessage } from "../compaction";
import type { DenialInfo } from "../tool-result";

export type LoopEvent =
  | "before_tool"
  | "after_tool"
  | "before_turn"
  | "transform_context"
  | "before_request"
  | "after_response"
  | "before_compaction"
  | "before_turn_end";

export interface BeforeToolPayload {
  readonly call: ToolCall;
  readonly tools: readonly ToolDefinition[];
}

/**
 * `before_tool` outcomes:
 *
 * - `allow` optionally rewrites the tool's input; later handlers see the
 *   rewrite, and the loop records it in the transcript and invokes the tool
 *   with it.
 * - `nudge` prefixes the eventual result with the handler's text.
 * - `block` answers without invoking the tool. `input` optionally carries the
 *   corrected input the transcript should record, which is how the
 *   invalid-call repair persists the exemplar it refuses to execute.
 * - `terminate` answers every outstanding call in the current batch — the spin
 *   breaker's stop is a batch-level outcome, not a per-call one, and a batch
 *   left with an unanswered `tool_call` is rejected by strict providers.
 */
export type BeforeToolOutcome =
  | { kind: "allow"; input?: Record<string, unknown> }
  | { kind: "nudge"; text: string }
  | { kind: "block"; content: string; isError?: boolean; input?: Record<string, unknown> }
  | { kind: "terminate"; content: string; isError?: boolean };

/**
 * What an `after_tool` handler may change. Deliberately partial: a handler
 * returns only the fields it wants patched.
 *
 * `denied` is NOT patchable — a refused Write is not a crashed Write (ADR-029
 * s5), and letting a handler flip that erases a distinction the model is meant
 * to act on.
 */
export type AfterToolPatch = {
  content?: string;
  isError?: boolean;
};

export interface AfterToolPayload {
  readonly content: string;
  readonly isError?: boolean;
  /** Surfaced to handlers, never writable by them. */
  readonly denied?: DenialInfo;
}

/** `before_turn` — fires once as a turn starts, after the transcript loads. */
export interface BeforeTurnPayload {
  readonly prompt: string;
  /** The loaded transcript. Readonly: only a boundary rewrite may touch it. */
  readonly history: readonly NativeTranscriptMessage[];
  readonly sessionName: string;
  /** PR 3 populates these from TranscriptFile.model; undefined until then. */
  readonly previousModel?: string;
  readonly currentModel?: string;
  /** Dispatcher-computed (spec 3.4). A handler may never assert a boundary. */
  readonly boundary: boolean;
}

export interface BeforeTurnPatch {
  /** The seed messages being appended now. */
  readonly seed?: readonly NativeTranscriptMessage[];
  /** Honoured ONLY when payload.boundary is true (spec 3.2, 6.1). */
  readonly history?: readonly NativeTranscriptMessage[];
}

/** `transform_context` — fires before every provider request attempt. */
export interface TransformContextPayload {
  readonly messages: readonly NativeTranscriptMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly model?: string;
  readonly anchorIndex?: number;
  readonly boundary: boolean;
}

export interface TransformContextPatch {
  readonly messages?: readonly NativeTranscriptMessage[];
}

/** `before_request` — per request ATTEMPT, including transport retries. */
export interface BeforeRequestPayload {
  readonly model?: string;
  readonly roundTrip: number;
  /** 1 for the first attempt, 2..n inside retryTransportFault. */
  readonly attempt: number;
  readonly options: CompleteCallOptions;
}

export interface BeforeRequestPatch {
  readonly options?: Partial<CompleteCallOptions>;
}

/**
 * The per-call options bag added to TurnDeps.complete in Task 4 (spec 6.3).
 * Minimal and additive by ruling: P6's extraction inherits one optional
 * parameter, not a new concept.
 */
export interface CompleteCallOptions {
  readonly thinking?: boolean;
  readonly temperature?: number;
}

/** `after_response` — fires on a settled assistant message. */
export interface AfterResponsePayload {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly thinking?: readonly ThinkingBlock[];
  /** Surfaced, NEVER patchable: billing truth is not a handler's to rewrite. */
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly roundTrip: number;
}

export interface AfterResponsePatch {
  readonly text?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly thinking?: readonly ThinkingBlock[];
}

/** `before_compaction` — fires in both the proactive and overflow branches. */
export interface BeforeCompactionPayload {
  readonly reason: "proactive" | "overflow";
  readonly toSummarize: readonly NativeTranscriptMessage[];
  readonly previousSummary?: string;
  readonly estimatedTokens: number;
}

export interface BeforeCompactionPatch {
  /** Honoured when reason is "proactive", IGNORED + logged when "overflow". */
  readonly decline?: boolean;
  /** A replacement summary, skipping the summarizer call. */
  readonly summary?: string;
}

/** `before_turn_end` — fires before the final saveTranscript. */
export interface BeforeTurnEndPayload {
  readonly messages: readonly NativeTranscriptMessage[];
  readonly roundTrips: number;
  /** True when the turn ended by a STOP; followUp is not offered then. */
  readonly stopped: boolean;
  readonly followUpsSoFar: number;
}

export interface BeforeTurnEndPatch {
  /** Re-enters the loop with another user turn. Capped; see registry.ts. */
  readonly followUp?: string;
}

export interface LoopEventMap {
  before_tool: { payload: BeforeToolPayload; patch: BeforeToolOutcome };
  after_tool: { payload: AfterToolPayload; patch: AfterToolPatch };
  before_turn: { payload: BeforeTurnPayload; patch: BeforeTurnPatch };
  transform_context: { payload: TransformContextPayload; patch: TransformContextPatch };
  before_request: { payload: BeforeRequestPayload; patch: BeforeRequestPatch };
  after_response: { payload: AfterResponsePayload; patch: AfterResponsePatch };
  before_compaction: { payload: BeforeCompactionPayload; patch: BeforeCompactionPatch };
  before_turn_end: { payload: BeforeTurnEndPayload; patch: BeforeTurnEndPatch };
}

export type PayloadOf<E extends LoopEvent> = LoopEventMap[E]["payload"];
export type PatchOf<E extends LoopEvent> = LoopEventMap[E]["patch"];
export type HandlerOf<E extends LoopEvent> = (payload: PayloadOf<E>) => PatchOf<E> | Promise<PatchOf<E>>;
