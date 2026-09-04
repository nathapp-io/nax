/**
 * Session-protocol types — the shapes exchanged across the openSession / sendTurn /
 * closeSession boundary, split out of types.ts under the file-size ratchet (#1702).
 *
 * Nothing here imports from ./types: the dependency runs one way (types.ts imports
 * and re-exports this module), so the split adds no import cycle. Every existing
 * import site keeps working unchanged — types.ts re-exports all of it.
 */

import type { ResolvedPermissions } from "../config/permissions";
import type { ModelDef, ModelTier } from "../config/schema";
import type { AdapterFailure, ToolDescriptor } from "../context/engine";
import type { ProtocolIds } from "../runtime/protocol-types";
import type { SessionRole } from "../runtime/session-role";
import type { TokenUsage } from "./cost";

/** trackedSpawn hard deadlines (ms) — teardown vs startup, resolved from config.agent.acp (#1583). */
export interface TrackedSpawnDeadlineOptions {
  trackedSpawnDeadlineMs?: number;
  trackedSpawnStartupDeadlineMs?: number;
}

/**
 * Opaque handle to an open agent session returned by openSession().
 * ACP adapter stores protocol state here; callers above the adapter boundary
 * only see the id, agentName, and optional protocolIds.
 */
export interface SessionHandle {
  /** Protocol-agnostic session identifier (equals the ACP session name). */
  readonly id: string;
  /** Agent name this session was opened for. */
  readonly agentName: string;
  /** Session role — populated when the caller knows the role at open time. */
  readonly role?: SessionRole;
  /** Protocol-specific IDs for SessionManager correlation. */
  readonly protocolIds?: ProtocolIds;
  /**
   * Model this session was opened with. Recorded on every turn's cost row so
   * spend is attributable to a model (#1433) — before this, cost rows carried
   * the literal string "unknown". Attribution only; never branch on it.
   */
  readonly modelDef?: ModelDef;
  /** Tier `modelDef` resolved from, when it came from one. Attribution only. */
  readonly modelTier?: ModelTier;
}

/** Options for openSession() — protocol-agnostic surface + ACP-specific pass-throughs. */
export interface OpenSessionOpts extends TrackedSpawnDeadlineOptions {
  agentName: string;
  workdir: string;
  /** Pre-resolved permissions from AgentManager. */
  resolvedPermissions: ResolvedPermissions;
  /** ACP: resolved model definition (required for client cmdStr + cost). */
  modelDef: ModelDef;
  /** Tier the model resolved from, when applicable. Attribution only (#1433). */
  modelTier?: ModelTier;
  /** ACP: maximum session duration in seconds. */
  timeoutSeconds: number;
  /** ACP: acpx --prompt-retries value (default 0 — opt-in). */
  promptRetries?: number;
  /** Fired once the session is physically established, before the first prompt. */
  onSessionEstablished?: (protocolIds: ProtocolIds, sessionName: string) => void;
  /** PID registration callback for crash-recovery bookkeeping. */
  onPidSpawned?: (pid: number) => void;
  /**
   * PID unregistration callback. Called when an acpx subprocess associated with this
   * session exits naturally — keeps PidRegistry from accumulating dead PIDs.
   */
  onPidExited?: (pid: number) => void;
  /** Abort signal — if already aborted, openSession rejects immediately. */
  signal?: AbortSignal;
  /**
   * When true, the session name is expected to already exist in the adapter's
   * store. The adapter should prefer resuming over creating a fresh session.
   * Set by SessionManager.openSession when a descriptor is found.
   */
  resume?: boolean;
  /**
   * Generic per-call lifecycle hook — invoked by the adapter when a physical
   * agent invocation begins, with a stable `callId` and an opaque cancel
   * function. The wiring layer uses this to register `cancel` in any per-call
   * cancellation registry it owns (e.g. the idle watchdog). The adapter does
   * not know what the consumer does with the cancel handle. Depopulation of
   * any registry happens via the `agent.call_ended` event on the stream bus.
   */
  onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
  /**
   * Stream activity callback forwarded from NaxRuntime.agentStreamEvents.
   * The adapter passes this to the underlying AcpClient so prompt-level events
   * (call_started, message_update, call_ended, etc.) are emitted on the runtime
   * bus. Required for the idle watchdog to track calls.
   */
  onStreamActivity?: (event: import("../runtime/agent-stream-events").AgentStreamEvent) => void;
  /**
   * Native: directory the session's transcript file lives in. Supplied by
   * SessionManager because the adapter cannot derive it — openSession runs
   * before the SessionDescriptor exists (manager.ts:472 vs :492), and no
   * scratch dir reaches the adapter otherwise. ACP ignores it.
   */
  transcriptDir?: string;
}

/** Options for sendTurn(). */
export interface SendTurnOpts {
  /** Unified callback for context-tool calls and agent questions. */
  interactionHandler: import("./interaction-handler").InteractionHandler;
  /** Abort signal for mid-turn cancellation. */
  signal?: AbortSignal;
  /** Max turns in multi-turn loop (default: 10). */
  maxTurns?: number;
  /**
   * Native: pull-tool catalogue for this turn, sent as structured tool
   * definitions. Under ACP the same catalogue is rendered into the prompt
   * instead, so that path ignores this.
   */
  contextPullTools?: readonly ToolDescriptor[];
  /** Coding tools advertised to the model this turn (already policy-filtered). */
  codingTools?: readonly import("@/tools").CodingTool[];
}

/** Result returned by sendTurn(). */
/**
 * A single mid-turn interactive Q&A exchange between the agent and a human
 * operator (routed via the interaction plugin), captured for the prompt-audit
 * trail (issue #1226).
 */
export interface InteractionExchange {
  /** Internal round-trip index (1-based) at which the question was asked. */
  readonly turnIndex: number;
  /** The agent's question text, as surfaced to the operator. */
  readonly question: string;
  /** The operator's verbatim reply (or the configured fallback on timeout). */
  readonly reply: string;
}

export interface TurnResult {
  /** Final assistant output from the last ACP response. */
  output: string;
  /** Accumulated token usage across all turns. */
  tokenUsage: TokenUsage;
  /** Estimated cost from token usage × pricing rates (always present). */
  estimatedCostUsd: number;
  /** Exact cost reported by wire protocol (when available). */
  exactCostUsd?: number;
  /** Number of session.prompt() calls made. */
  internalRoundTrips: number;
  /**
   * Mid-turn human-in-the-loop Q&A exchanges captured during the session turn
   * (issue #1226). Each entry pairs the agent's question with the operator's
   * verbatim reply and the internal round-trip index at which it occurred.
   * Omitted when no interactive question was answered — context-tool round-trips
   * are NOT recorded here. Surfaced onto DispatchEvent and the prompt audit trail.
   */
  interactions?: readonly InteractionExchange[];
  /**
   * Coding tools advertised to this turn, and the ones the model actually
   * invoked. Present only when coding tools were advertised, so "absent" and
   * "advertised but unused" stay distinguishable — the review guards treat
   * those two cases differently.
   *
   * A turn-observed fact surfaced to the wiring layer, like `interactions`.
   */
  codingToolUse?: { readonly advertised: number; readonly called: readonly string[] };
  /** Protocol-specific IDs for prompt-audit correlation. */
  protocolIds?: ProtocolIds;
  /**
   * Set when the hop body synthesises a failure (e.g. empty output) rather than
   * receiving a real adapter error. Propagated through buildHopCallback into
   * AgentResult.adapterFailure so the manager's swap/retry policy sees the correct
   * outcome (e.g. `fail-stale` on empty output).
   */
  adapterFailure?: AdapterFailure;
  /**
   * Transport fact: `sendTurn()` returned because its wall-clock timeout
   * elapsed. The adapter never classifies _why_ — the wiring layer (callOp
   * via turn-failure-classification) maps empty timed-out output to the
   * `fail-timeout` policy outcome. Absent or false when the turn completed
   * normally or was aborted.
   */
  timedOut?: boolean;
  /**
   * Transport fact: the loop returned while the model still had tool calls
   * pending — it asked for work that was never executed and never answered.
   *
   * Defined by the condition, not by enumerating exits, so its meaning is
   * stable as the exits change: today the round-trip cap, the whole-turn
   * deadline and an abort can all produce it; once the cap is removed only the
   * deadline and abort can. Like `timedOut`, the adapter never classifies WHY —
   * the wiring layer does (see operations/turn-failure-classification.ts).
   */
  turnIncomplete?: boolean;
}

/**
 * Throwable form of TurnResult. Surfaced by `sendTurn()` when the underlying
 * session ended with `stopReason === "error"`. Carries `cancelled: true`
 * when the failure was caused by an external cancel (`cancelActivePrompt()`),
 * so the wiring layer (SessionManager) can classify it as `fail-stale`
 * without the adapter naming a policy outcome.
 */
export class SessionTurnError extends Error {
  constructor(
    message: string,
    public readonly cancelled: boolean,
    public readonly retryable: boolean = false,
    /**
     * BUG-57: token usage accumulated across all turns of the sendTurn() call,
     * including the turn that ended in stopReason:"error" (e.g. a mid-flight
     * cancel). Callers that catch SessionTurnError (build-hop-callback.ts,
     * session-run-hop.ts) must read cost/tokens from here instead of
     * hardcoding zero — tokens already burned before the failure are real
     * spend and must not be dropped from cost accounting.
     */
    public readonly tokenUsage?: TokenUsage,
    public readonly estimatedCostUsd?: number,
    public readonly exactCostUsd?: number,
  ) {
    super(message);
    this.name = "SessionTurnError";
  }
}
