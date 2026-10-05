/**
 * Session-protocol types — the shapes exchanged across the openSession / sendTurn /
 * closeSession boundary, split out of types.ts under the file-size ratchet (#1702).
 *
 * Nothing here imports back into types.ts, so the split adds no import cycle:
 * the dependency runs one way. `types.ts` stayed in nax
 * (`packages/nax/src/agents/types.ts`) and reaches this module through the
 * `@nathapp/nax-agent` entry. It re-exports a *selected subset* — the session
 * protocol's public contract — so existing `@/agents/types` import sites keep
 * working; a consumer of anything outside that subset (`AuthStamp`,
 * `InvalidToolCallDetail`) imports it from `@nathapp/nax-agent` directly.
 */

import type { Pricing, PricingRates, TokenUsage } from "#src/cost/standard-types";
import type { ResolvedPermissions } from "#src/permissions/index";
import type { ProtocolIds } from "#src/session/protocol-types";
import type { AdapterFailure } from "./adapter-failure.ts";
import type { ToolDescriptor } from "./tool-descriptor.ts";

/**
 * Identity of the credential that served a call (US-002).
 *
 * Deliberately carries no secret: `fingerprint` is the keyed digest, and
 * `source` / `account` say where the credential came from without exposing it.
 * Declared here — once — so every consumer imports one definition rather than
 * re-spelling the shape.
 */
export interface AuthStamp {
  /** Keyed credential digest (see `fingerprint.ts`). Not comparable across machines. */
  fingerprint: string;
  /** Where the credential was read from: the `file` store, an `exec` helper, or an in-process `memory` store. */
  source: "file" | "exec" | "memory";
  /** Account label the source reported, when it reports one. */
  account?: string;
}

/**
 * The model a session runs on, in the contract's own vocabulary (S1 spec section
 * 4.2, port 2). nax builds it from its config `ModelDef` with `toSessionModel`
 * (`packages/nax/src/agents/session-model-mapping.ts`); `pricing` is already
 * converted to the standard rate card, so the session never sees config field
 * names.
 */
export interface SessionModel {
  readonly provider: string;
  readonly model: string;
  /** Explicit rate override; absent means "price from the catalog". */
  readonly pricing?: Pricing;
  /** Overrides the catalog context window for compaction maths only (nax#1848). */
  readonly contextWindow?: number;
  /** Extra environment for transports that spawn a process (ACP). */
  readonly env?: Record<string, string>;
}

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
  /**
   * Session role, opaque to the adapter. nax writes a canonical role; read it
   * through `knownSessionRole`.
   */
  readonly role?: string;
  /** Protocol-specific IDs for SessionManager correlation. */
  readonly protocolIds?: ProtocolIds;
  /**
   * Model this session was opened with. Recorded on every turn's cost row so
   * spend is attributable to a model (#1433) — before this, cost rows carried
   * the literal string "unknown". Attribution, and the session's endpoint identity: `decideReuse`
   * (session/endpoint-identity.ts) compares it to decide whether a re-open under
   * the same session name may serve this handle, and the native adapter's
   * `sendTurn` dispatches from it. Do not branch on it for anything else.
   */
  readonly modelDef?: SessionModel;
  /** Tier `modelDef` resolved from, when it came from one. Attribution only. */
  readonly modelTier?: string;
}

/** Options for openSession() — protocol-agnostic surface + ACP-specific pass-throughs. */
export interface OpenSessionOpts extends TrackedSpawnDeadlineOptions {
  agentName: string;
  workdir: string;
  /** Pre-resolved permissions from AgentManager. */
  resolvedPermissions: ResolvedPermissions;
  /** The model to open with. nax builds it with `toSessionModel`. */
  modelDef: SessionModel;
  /** Tier the model resolved from, when applicable. Attribution only (#1433). */
  modelTier?: string;
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
  onStreamActivity?: (event: import("#src/session/agent-stream-events").AgentStreamEvent) => void;
  /**
   * Native: directory the session's transcript file lives in. Supplied by
   * SessionManager because the adapter cannot derive it — openSession runs
   * before the SessionDescriptor exists (manager.ts:472 vs :492), and no
   * scratch dir reaches the adapter otherwise. ACP ignores it.
   */
  transcriptDir?: string;
  /**
   * Native: identity that owns this session's transcript — the op invocation's
   * `scopeId ?? callId`. Stable across the retries and hops of one invocation,
   * different for every new stage entry, run and process, which is exactly the
   * boundary transcript resumption must respect (nax#1877). ACP ignores it.
   */
  transcriptOwner?: string;
  /**
   * Native: where the session's history lives (S3 spec 5.5). Mutually exclusive
   * with `transcriptDir`, which is shorthand for the file store; exactly one of
   * the two must be set. nax sets `transcriptDir`. ACP ignores it.
   */
  transcriptStore?: import("#src/native/session/transcript-types").TranscriptStore;
  /**
   * Native: leave the live transcript in place on close (S3 spec 5.5). By
   * default a clean close deletes it and a failed close moves it aside; the
   * facade sets this so the session stays resumable. nax leaves it unset.
   * Limitation: the file store's prune on a failed close (cap 50, oldest first)
   * counts every transcript in its directory, live ones included, so a
   * retained session should not share a file-store directory with sessions
   * that close failed.
   */
  retainOnClose?: boolean;
  /**
   * Native: the session's system prompt, sent as the request's top-level
   * `system` on every round trip (not on the compaction summary). The S3
   * facade sets it from `instructions`; nax leaves it unset. ACP ignores it.
   */
  systemPrompt?: string;
  /**
   * Native: resolved compaction settings. A resolved primitive, never NaxConfig —
   * src/agents/native/ must not read config (check:adapter-no-config-import).
   */
  compaction?: import("#src/native/session/compaction").ResolvedCompaction;
  /**
   * Native: resolved transport-fault retry settings (nax#1870), threaded the
   * same way as `compaction` — a resolved primitive, never NaxConfig. ACP
   * ignores it; acpx has its own knob (`promptRetries`).
   */
  transportRetry?: import("#src/native/session/turn-retry").TurnRetryConfig;
  /**
   * Native: resolved repetition-breaker settings (nax#2013), threaded the same
   * way as `compaction` and `transportRetry` — a resolved primitive, never
   * NaxConfig. ACP ignores it; its loop is bounded by `maxInteractions`.
   */
  spinBreaker?: import("#src/infra/spin-breaker/index").ResolvedSpinBreakerSettings;
}

/** Options for sendTurn(). */
export interface SendTurnOpts {
  /** Unified callback for context-tool calls and agent questions. */
  interactionHandler: import("./interaction-handler.ts").InteractionHandler;
  /** Native-only in-process loop-event registrations for this turn. ACP ignores this. */
  loopEvents?: import("#src/native/session/loop-events/index").LoopEventRegistry;
  /**
   * Native: the run's plugin-contributed loop handlers (US-003), attached by
   * `SessionManager.sendPrompt`. The adapter forwards them into the turn's
   * deps, where `registerBuiltinLoopHandlers` installs them between the
   * built-ins. ACP ignores this.
   */
  loopHandlers?: import("#src/native/session/loop-events/index").LoopHandlerSet;
  /**
   * Native: the read-only facts every plugin handler is handed (US-003). ACP
   * ignores this.
   */
  loopHandlerContext?: import("#src/native/session/loop-events/index").LoopHandlerContext;
  /** Abort signal for mid-turn cancellation. */
  signal?: AbortSignal;
  /**
   * Human/context interaction budget for this turn, from
   * `agent.maxInteractionTurns` (default: 10).
   *
   * NOT an agent round-trip cap, and the two transports spend it on
   * different things — see each adapter's read site. It was called
   * `maxTurns` until issue #1829, which is how issue #1820 happened: the
   * native loop spent the Q&A budget as its round-trip cap and truncated
   * real work at 10.
   */
  maxInteractions?: number;
  /**
   * Native: pull-tool catalogue for this turn, sent as structured tool
   * definitions. Under ACP the same catalogue is rendered into the prompt
   * instead, so that path ignores this.
   */
  contextPullTools?: readonly ToolDescriptor[];
  /** Coding tools advertised to the model this turn (already policy-filtered). */
  codingTools?: readonly import("#src/tools/index").CodingTool[];
  /**
   * Identity for THIS turn, minted by `runAsSession` before the turn runs.
   *
   * One turn is one cost row, so this is the field that selects a single row —
   * `callId` spans retries and hops and cannot. Minted ahead of `sendPrompt`
   * precisely so tool calls made during the turn can carry it.
   */
  turnId?: string;
  /**
   * S3-3: per-turn event sink (deltas, stream_reset, tool calls and results,
   * per-round usage, compaction). Native honours it; ACP ignores it until S4.
   * Called synchronously; a throw or rejection is contained by the backend.
   * nax sets none.
   */
  onTurnEvent?: import("./turn-event.ts").TurnEventSink;
}

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
  /** Absent means computed. */
  costSource?: import("./agent-session-types.ts").CostSource;
  /** Number of session.prompt() calls made. */
  internalRoundTrips: number;
  /**
   * Which rate card priced this turn (US-003, first half of #1817).
   * `"catalog-rates"` means nax-ai's catalog; `"config-override"` means an
   * explicit `modelDef.pricing` won wholesale; `"fallback-rates"` means the
   * generic $3/$15-per-1M card applied because nothing more specific
   * resolved. Set by adapters that resolve a rate card — native (US-003)
   * and ACP, which stamps its card's branch on every result (US-002).
   * Absent only when the adapter resolved no card.
   */
  pricingSource?: "catalog-rates" | "config-override" | "fallback-rates";
  /**
   * The per-1M rates that priced this turn — US-002. Stamped from
   * `priceCall(usage, rates).resolvedRates` so the cost row can record the
   * same numbers whose arithmetic reproduces `estimatedCostUsd`. ACP
   * present only when nonzero usage let pricing run; absent on a zeroed
   * accumulator so "priced" and "did not price" stay distinguishable.
   */
  rates?: PricingRates;
  /** US-006: identity of the credential that served this turn. Absent for ACP turns. */
  auth?: AuthStamp;
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
  /**
   * Transport fact: the loop returned because the spin breaker stopped it —
   * the model kept issuing calls whose shape it had already issued, with no
   * new work between them (nax#2013).
   *
   * Like `timedOut` and `turnIncomplete`, the adapter never classifies WHY; the
   * wiring layer maps it to the `fail-spin` policy outcome
   * (operations/call-hop-output.ts). A spin-stopped turn also sets
   * `turnIncomplete`, since work the model asked for was left unexecuted.
   */
  spinStopped?: true;
  /**
   * Transport fact: the loop returned because three identical invalid tool
   * calls — same tool, same `stableStringify`'d input — repeated in this turn
   * (nax#2047, Task 4). A malformed shape is a stronger signal than spin
   * repetition: it is never going to recover by being issued again.
   *
   * A sibling flag rather than a value of `spinStopped` because the
   * classification channels are distinct (the wiring layer maps each to a
   * different policy outcome). Like `spinStopped`, a budget-stopped turn also
   * sets `turnIncomplete`, since the third call was left unexecuted.
   */
  invalidCallBudgetExceeded?: true;
  /**
   * The call that tripped the invalid-call budget, present exactly when
   * `invalidCallBudgetExceeded` is (nax#2200). Carried so the wiring layer can
   * classify the halt as `fail-invalid-tool-call` and the retry prompt can name
   * the rejected tool and property instead of reporting a timeout.
   */
  invalidToolCall?: InvalidToolCallDetail;
}

/**
 * A tool call the native loop rejected against the tool's own input schema
 * (nax#2047, surfaced by nax#2200): the validator's violation plus the tool it
 * was raised against. Every field is model-facing text for the retry prompt.
 */
export interface InvalidToolCallDetail {
  /** The tool the model called. */
  readonly tool: string;
  /** The offending top-level property. */
  readonly property: string;
  /** What the schema expects, e.g. "array", "one of: a, b", "present". */
  readonly expected: string;
  /** What the model sent, e.g. "a string", "absent". */
  readonly actual: string;
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
    /**
     * US-002: which rate card priced the failed turn's accumulated spend.
     * Set by the ACP adapter (`rateCard.source` — `"catalog-rates"` |
     * `"fallback-rates"`); the native adapter's protocol-fault path does not
     * set it, so the field is optional and absent there.
     */
    public readonly pricingSource?: "catalog-rates" | "fallback-rates",
    /**
     * nax#1840: the native path throws exactly one class per turn failure, so
     * classification (normally read off SessionFailureError.adapterFailure)
     * and cost (read off this class) cannot both be carried unless one class
     * carries both. Left undefined by the ACP path, which still throws
     * SessionFailureError for its own classified faults — this field only
     * ever gets set by native's sendTurn.
     */
    public readonly adapterFailure?: AdapterFailure,
  ) {
    super(message);
    this.name = "SessionTurnError";
  }
}

/**
 * The session half of an agent adapter: the surface a session runtime needs
 * (S1 spec section 4.2, port 2). nax's `AgentAdapter` extends it with the
 * process-description members and one-shot `complete()`.
 */
export interface AgentSessionAdapter {
  /**
   * Probe whether the agent has usable credentials (env var, ping, etc.).
   * Optional — adapters that do not implement it are treated as always credentialed.
   * Used by AgentManager.validateCredentials() at run start.
   */
  hasCredentials?(): Promise<boolean>;

  /**
   * Open a new (or resume an existing) physical agent session.
   * Returns an opaque SessionHandle carrying all state needed for subsequent
   * sendTurn() and closeSession() calls.
   */
  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>;

  /**
   * Send one or more turns to an open session and return the accumulated result.
   * Handles context-tool and question interactions via opts.interactionHandler.
   */
  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult>;

  /** Close the physical session and its underlying transport client. Best-effort — errors are swallowed. */
  closeSession(handle: SessionHandle): Promise<void>;

  /**
   * Close a session the process no longer holds a live handle for, addressing it by
   * id and workdir rather than by SessionHandle. Distinct from closeSession(): that
   * one closes an open in-process session, this one reconnects to the agent to close
   * a session left behind — the path run teardown takes
   * (src/execution/session-manager-runtime.ts).
   *
   * Optional because out-of-process teardown is not something every adapter can offer;
   * callers treat its absence as "nothing to close" and must invoke it best-effort.
   * Declared here rather than reached through a cast: it was undeclared until #1702,
   * so teardown had to assert its way to it and the two methods' handle types
   * (SessionHandle vs id string) disagreed invisibly.
   */
  closePhysicalSession?(
    handle: string,
    workdir: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<void>;
}
