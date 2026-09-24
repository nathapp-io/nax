/**
 * Public types and failure-usage ledger for the native turn loop.
 *
 * `runNativeTurn` (turn-loop.ts) carries this file's types as parameters; this
 * file owns their shape. Splitting them out keeps turn-loop.ts focused on the
 * algorithm and the file under the 600-line hard limit (see
 * .nax/rules/project-conventions.md).
 *
 * The failure-usage ledger (`failureUsageByError` WeakMap +
 * `recordNativeTurnFailureUsage` / `readNativeTurnFailureUsage`) also lives
 * here: it is module-level state with a process-lifetime scope, and the
 * loop's catch block only ever calls the write side through this file's
 * public API. Adapter.ts reads through `readNativeTurnFailureUsage` to
 * attribute round-trip spend to the error a failed turn threw (nax#1840).
 */

import type { ConversationMessage, ThinkingBlock, ToolCall } from "@nathapp/nax-ai";
import type { ResolvedRates, TokenUsage } from "@/agents/cost";
import type { TurnDeadline } from "@/agents/turn-deadline";
import type { SpinBreaker } from "@/runtime/spin-breaker";
import type { TranscriptMessage as NativeTranscriptMessage, ResolvedCompaction } from "./compaction";
import type { CompleteCallOptions, LoopEventRegistry } from "./loop-events";
import type { toToolDefinitions } from "./tool-mapping";
import type { TurnRetryConfig } from "./turn-retry";

export interface NativeTurnResponse {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly thinking?: readonly ThinkingBlock[];
  readonly usage: TokenUsage;
  readonly costUsd: number;
  /**
   * US-002: the per-1M rates that priced this round-trip's `costUsd`.
   * `runNativeTurn` stamps the LAST round-trip's `rates` on the
   * `TurnResult` it returns — each round-trip re-prices on its own usage,
   * and the most recent decision is what affected the user's last-mile
   * spend. Optional so existing test fakes that build the response shape
   * by hand keep compiling; the adapter's `complete` closure always sets
   * it because native prices unconditionally.
   */
  readonly rates?: import("../../cost").ResolvedRates;
}

/** What one summarization call returns. Usage and cost are surfaced, not swallowed. */
export interface NativeSummaryResponse {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  /** Per-1M rates that priced this summary call, when known. */
  readonly rates?: ResolvedRates;
}

export interface TurnDeps {
  complete(
    messages: readonly ConversationMessage[],
    tools: ReturnType<typeof toToolDefinitions>,
    options?: CompleteCallOptions,
  ): Promise<NativeTurnResponse>;
  /**
   * One model call, no tools, used only to summarize a dropped span. Separate
   * from complete() because it must not advertise tools, must not count as a
   * round trip, and its cost must be attributable.
   */
  summarize?(messages: readonly NativeTranscriptMessage[], previousSummary?: string): Promise<NativeSummaryResponse>;
  /** ResolvedModel.contextWindow. Absent disables compaction. */
  contextWindow?: number;
  /** Resolved settings. Absent disables compaction. */
  compaction?: ResolvedCompaction;
  /**
   * Whole-turn wall-clock budget. Absent means unbounded — the adapter always
   * supplies one for a real session; tests may omit it.
   */
  deadline?: TurnDeadline;
  /**
   * Per-round-trip observability hook. Absent in unit tests; the adapter
   * supplies one that forwards onto the runtime stream bus so the idle
   * watchdog can see native sessions.
   */
  onActivity?: (activity: import("./turn-events").NativeTurnActivity) => void;
  /**
   * Which rate card priced this turn (US-003, first half of #1817). Absent
   * on tests that build TurnDeps by hand and do not care about the source.
   * When set, propagates to the returned TurnResult as `pricingSource` so the
   * dispatch layer can stamp the row without re-deriving the rate-card branch.
   */
  pricingSource?: "catalog-rates" | "config-override";
  /**
   * nax#1870: bounded retry for a transport/overloaded fault thrown by
   * deps.complete, resolved from `agent.native.transportRetry`. Absent
   * disables retry — the pre-#1870 behaviour of rethrowing immediately.
   */
  transportRetry?: TurnRetryConfig;
  /**
   * Injectable sleep for the transport-retry backoff, so tests never
   * actually wait (forbidden-patterns-tests.md). Absent uses a real timer —
   * a real session always wants to actually wait.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Live repetition-breaker instance (nax#2013, session-lifetime since #2047). Absent disables the breaker.
   */
  spinBreaker?: SpinBreaker;
  /**
   * The one per-turn abort signal (US-002). The adapter builds it as
   * `AbortSignal.any` over the caller's `opts.signal`, the watchdog's
   * `turnController.signal` and a whole-turn deadline timer, and hands it to
   * the loop; the loop's batch consults it between tool calls so a cancelled
   * turn stops dispatching subsequent native tool calls. Absent in tests that
   * drive the loop without cancellation.
   */
  signal?: AbortSignal;
  /**
   * The in-process `before_tool` / `after_tool` seam (nax#2151, US-002).
   * Absent is the normal case for a real session: the loop then builds its own
   * registry, so the built-in handlers (invalid-call repair, spin breaker) run
   * regardless. Supplying one is how a caller adds handlers — or observes the
   * genuine-result dispatch sites — without the loop owning them.
   *
   * Per-turn, like the rest of `TurnDeps`: the loop registers its built-ins on
   * the registry it is given, because both of them reset with the turn.
   */
  loopEvents?: LoopEventRegistry;
}

/**
 * nax#1840: round trips completed before a turn fails still spent real money.
 * `inputTokens`/`outputTokens`/`costUsd` are locals inside runNativeTurn and
 * reach a caller only through the clean-exit return, so a throw at round trip
 * N silently drops everything spent on round trips 1..N-1.
 *
 * Recorded against the thrown error's own identity (a WeakMap), never by
 * mutating the error itself: adapter.ts's `isProtocolStreamError` guard and
 * its "propagate a non-protocol error untouched" rule both depend on the
 * error's own shape staying exactly what was thrown.
 */
export interface NativeTurnFailureUsage {
  readonly tokenUsage: TokenUsage;
  readonly costUsd: number;
}

const failureUsageByError = new WeakMap<object, NativeTurnFailureUsage>();

/** Writes the spend a failed turn accumulated, keyed on the error's own identity. */
export function recordNativeTurnFailureUsage(err: object, usage: NativeTurnFailureUsage): void {
  failureUsageByError.set(err, usage);
}

/** Reads back what the catch block recorded, if anything did. */
export function readNativeTurnFailureUsage(err: unknown): NativeTurnFailureUsage | undefined {
  return typeof err === "object" && err !== null ? failureUsageByError.get(err) : undefined;
}

/**
 * Translate a `TokenUsage`'s cache fields into the spread that the
 * `usage`-kind activity beat takes. Absent stays absent (never 0): the
 * caller distinguishes "no cache data" from "zero cache tokens" downstream
 * (nax#2045).
 */
export function cacheUsageFields(usage: TokenUsage): { cacheRead?: number; cacheWrite?: number } {
  return {
    ...(usage.cacheReadInputTokens !== undefined ? { cacheRead: usage.cacheReadInputTokens } : {}),
    ...(usage.cacheCreationInputTokens !== undefined ? { cacheWrite: usage.cacheCreationInputTokens } : {}),
  };
}
