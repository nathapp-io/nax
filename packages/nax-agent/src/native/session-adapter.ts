/**
 * The native session adapter: openSession / sendTurn / closeSession over
 * nax-ai, no subprocess. openSession/closeSession are transcript-file
 * bookkeeping, and sendTurn maps the native turn loop (session/turn-loop.ts)
 * over complete() — nax owns the conversation because nax-ai's client is
 * stateless (ADR-027 section 10, ADR-028).
 */

import { randomUUID } from "node:crypto";
import type { Client } from "@nathapp/nax-ai";
import { priceCall } from "#src/cost/core/index";
import { getSafeLogger, NaxError } from "#src/infra/index";
import {
  type AgentSessionAdapter,
  type OpenSessionOpts,
  type SendTurnOpts,
  type SessionHandle,
  SessionTurnError,
  type TurnResult,
} from "#src/session/session-types";
import { createTurnDeadline } from "#src/session/turn-deadline";
import { _adapterDeps, authFields, isProtocolStreamError } from "./adapter-deps.ts";
import { _clientDeps, getNativeClient, type NativeCatalogOverrides } from "./client.ts";
import type { GuardedCredentialStore } from "./credentials/index.ts";
import { type CredentialSource, createSessionCredentialStore } from "./credentials/session-source.ts";
import { toAdapterFailure } from "./errors.ts";
import { buildRateCard, NATIVE_AGENT, parseNativeModel, resolveContextWindow, toThinkingLevel } from "./models.ts";
import {
  closeNativeSession,
  createNativeSessionState,
  markNativeTurnOutcome,
  type NativeSessionState,
  openNativeSession,
} from "./session/session.ts";
import { buildNativeStreamEvent } from "./session/turn-events.ts";
import { runNativeTurn } from "./session/turn-loop.ts";
import { readNativeTurnFailureUsage, type TurnDeps } from "./session/turn-types.ts";
import { nativeSessionId } from "./session-affinity.ts";

/**
 * Fallback whole-turn budget when a session's timeout entry is missing.
 *
 * Matches `execution.sessionTimeoutSeconds`' own default. The turn MUST stay
 * bounded: an absent entry previously degraded to an unbounded deadline with
 * no per-call timer either, silently removing the guard this module exists to
 * apply. Bounded-and-logged beats unbounded-and-quiet.
 */
const FALLBACK_TURN_TIMEOUT_SECONDS = 3600;

function summaryPrompt(previousSummary?: string): string {
  const base =
    "Summarize the conversation above so it can be dropped from context. " +
    "Record what was attempted, what was rejected and why, any decisions that still bind, " +
    "and list the files read and the files modified. Be specific: this summary is the only " +
    "memory of this work that survives.";
  if (previousSummary === undefined) return base;
  return (
    `${base}\n\nAn earlier summary of still-older history follows. Merge it into your summary ` +
    `rather than repeating or discarding it:\n\n${previousSummary}`
  );
}

/**
 * US-003: the plugin-contributed loop handlers a turn carries, in the shape
 * `runNativeTurn` takes them in. Built here rather than inline in `sendTurn`
 * because those two conditional spreads are what pushed that method past its
 * recorded cognitive complexity; each field is omitted entirely when the
 * caller supplied none, so a session that loaded no `loop-handlers` plugin
 * carries neither key.
 */
function loopHandlerDeps(opts: SendTurnOpts): Pick<TurnDeps, "loopHandlers" | "loopHandlerContext"> {
  return {
    ...(opts.loopHandlers !== undefined ? { loopHandlers: opts.loopHandlers } : {}),
    ...(opts.loopHandlerContext !== undefined ? { loopHandlerContext: opts.loopHandlerContext } : {}),
  };
}

const adapterStates = new WeakMap<NativeSessionAdapter, NativeSessionState>();

/** The adapter's per-session state. `/internal` only: tests and the S3 facade read it; nax never does. */
export function nativeSessionStateOf(adapter: NativeSessionAdapter): NativeSessionState {
  const state = adapterStates.get(adapter);
  if (state === undefined) {
    throw new NaxError("NativeSessionAdapter has no session state", "NATIVE_SESSION_STATE_MISSING", {
      stage: "native-session",
    });
  }
  return state;
}

/** Options for an adapter that owns its client and/or its credentials (S3 5.2). */
export interface NativeSessionAdapterOptions {
  /** A credential source owned by this adapter. Implies an owned client. */
  readonly credentials?: CredentialSource;
  /** Build and own a client even without `credentials` (for per-session catalog overrides). */
  readonly ownClient?: boolean;
}

export class NativeSessionAdapter implements AgentSessionAdapter {
  private readonly ownStore: GuardedCredentialStore | undefined;
  private ownClient: Promise<Client> | undefined;
  private readonly owns: boolean;

  constructor(
    private readonly catalogOverrides: NativeCatalogOverrides = [],
    options: NativeSessionAdapterOptions = {},
  ) {
    adapterStates.set(this, createNativeSessionState());
    this.ownStore = options.credentials !== undefined ? createSessionCredentialStore(options.credentials) : undefined;
    this.owns = this.ownStore !== undefined || options.ownClient === true;
  }

  /** The module memo for nax (one client per process, as before); an owned client for an embedder session. */
  private client(): Promise<Client> {
    if (!this.owns) return getNativeClient(this.catalogOverrides);
    this.ownClient ??= _clientDeps
      .build(this.catalogOverrides, this.ownStore !== undefined ? { credentials: this.ownStore } : {})
      .catch((err: unknown) => {
        this.ownClient = undefined;
        throw err;
      });
    return this.ownClient;
  }

  private get state(): NativeSessionState {
    return nativeSessionStateOf(this);
  }

  /**
   * Can this agent authenticate to at least one provider?
   *
   * Deliberately not "is the provider this run needs satisfied": this method
   * takes no provider, and it cannot get one. The registry receives the
   * manager's config slice, and agentManagerConfigSelector excludes
   * config.models by design (ADR-019). Probing every provider for a specific
   * answer is not an alternative either — pi's resolve() may execute commands.
   *
   * So this prunes exactly one case: nothing stored anywhere and nothing
   * ambient. That is the real failure — a user who has never run
   * `nax auth login` and has no provider environment variables — and every
   * native call is going to fail anyway. A wrong-provider credential still
   * surfaces per request, through the typed mapping from ProtocolError.kind
   * "auth" to availability / fail-auth.
   *
   * US-004: with `auth.source: "exec"` it answers true without asking anything.
   * A helper's providers cannot be listed, so an empty credential file says
   * nothing about whether this run can authenticate — and spawning the helper
   * here would put a credential read before the run has any reason for one.
   *
   * Errors resolve to true. Pruning an agent that would have worked kills a
   * run; the opposite costs one request-time error that is already handled.
   */
  async hasCredentials(): Promise<boolean> {
    try {
      if (this.ownStore !== undefined) return true;
      if (await _adapterDeps.authSourceIsExec()) return true;
      if ((await _adapterDeps.listStoredProviders()).length > 0) return true;
      return await _adapterDeps.anyAmbientCredential();
    } catch {
      return true;
    }
  }

  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
    return openNativeSession(this.state, name, opts);
  }

  async sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
    const { provider, model, effort } = parseNativeModel(handle.modelDef?.model ?? "");
    const thinking = toThinkingLevel(effort);
    const client = await this.client();
    const resolved = await client.model(provider, model);
    const catalog = client.pricing(resolved);
    const { rates, source: pricingSource } = buildRateCard(catalog, handle.modelDef?.pricing);
    const storedTimeoutSeconds = this.state.timeouts.get(handle.id);
    if (storedTimeoutSeconds === undefined) {
      getSafeLogger()?.warn("native-adapter", "session has no recorded timeout; falling back to the default budget", {
        sessionName: handle.id,
        fallbackTimeoutSeconds: FALLBACK_TURN_TIMEOUT_SECONDS,
      });
    }
    const timeoutSeconds = storedTimeoutSeconds ?? FALLBACK_TURN_TIMEOUT_SECONDS;
    // Keyed on the session, so every turn of one conversation carries the same
    // id and the provider can keep its cache warm across them.
    const sessionId = nativeSessionId(handle.id);

    // One budget for the whole turn, not one per round-trip. Created here
    // because this is where `timeoutSeconds` is known; consulted by the loop.
    const deadline = createTurnDeadline(timeoutSeconds);

    const hooks = this.state.streamHooks.get(handle.id);
    // One callId per turn, mirroring SpawnAcpSession.prompt(). `runId` is
    // backfilled by the runtime's forwarding closure, which is the only place
    // that knows it — see runtime/index.ts.
    const callId = randomUUID();
    // The transcript/ledger join key, not a stream id. `this.state.transcriptOwners`
    // is keyed on this same `handle.id` and already holds the session's
    // `transcriptOwner` (`scopeId ?? callId` from session-run-hop.ts). Omitted
    // entirely when the session declared no owner, so an absent key reads as
    // "unknown" rather than as a wrong one.
    const owner = this.state.transcriptOwners.get(handle.id);
    const eventBase = {
      callId,
      runId: "",
      agentName: handle.agentName,
      sessionName: handle.id,
      ...(owner !== undefined ? { scopeId: owner } : {}),
    };
    const turnController = new AbortController();
    // The watchdog's cancel handle IS the turn controller, so an idle cancel
    // and the whole-turn deadline end the same in-flight call. Registering
    // through the hook (rather than a private registry) is what lets
    // sendPrompt tell a watchdog cancel from an unrelated process kill.
    hooks?.onActiveCall?.(callId, async () => turnController.abort());
    hooks?.onStreamActivity?.({
      ...eventBase,
      kind: "agent.call_started",
      model: handle.modelDef?.model ?? "",
      timeoutSeconds,
      timestamp: Date.now(),
    });

    // US-002: one per-turn signal, fanned in from the caller's
    // `opts.signal`, the watchdog's `turnController.signal`, and a
    // whole-turn deadline timer armed with `deadline.remainingMs()`. The
    // timer is cleared at turn settlement (finally, below) so the AbortSignal
    // any(...) does not keep a timer alive past the turn's end. Complete and
    // summarize retain their per-call timers but combine them with this same
    // turnSignal so a turn-cancel reaches an in-flight call mid-roundtrip.
    const deadlineController = new AbortController();
    const deadlineMs = deadline.remainingMs();
    const deadlineTimer =
      deadlineMs !== undefined ? _adapterDeps.setTimeout(() => deadlineController.abort(), deadlineMs) : undefined;
    const turnSignals: AbortSignal[] = [turnController.signal, deadlineController.signal];
    if (opts.signal !== undefined) turnSignals.unshift(opts.signal);
    const turnSignal = AbortSignal.any(turnSignals);

    let result: TurnResult;
    try {
      // US-002: clear the deadline timer at turn settlement, no matter how
      // the turn ends (clean exit, throw, or any other path). The
      // `AbortSignal.any` above holds a reference to `deadlineController.signal`,
      // so a settled turn must drop its timer to avoid keeping it armed past
      // the turn boundary.
      result = await runNativeTurn(handle, prompt, opts, {
        sessionState: this.state,
        deadline,
        contextWindow: resolveContextWindow(handle.modelDef?.contextWindow, resolved.contextWindow),
        ...(this.state.compaction.get(handle.id) !== undefined
          ? { compaction: this.state.compaction.get(handle.id) }
          : {}),
        ...(this.state.transportRetry.get(handle.id) !== undefined
          ? { transportRetry: this.state.transportRetry.get(handle.id) }
          : {}),
        ...(this.state.spinBreakers.get(handle.id) !== undefined
          ? { spinBreaker: this.state.spinBreakers.get(handle.id) }
          : {}),
        ...(opts.loopEvents !== undefined ? { loopEvents: opts.loopEvents } : {}),
        // US-003: the run's plugin-contributed loop handlers and the facts
        // their handlers read travel the same way as `loopEvents` — both are
        // per-turn inputs the loop installs onto its registry rather than
        // state the adapter owns.
        ...loopHandlerDeps(opts),
        // US-002: the one per-turn signal threaded into the batch and the
        // in-flight coding-tool runtime. When `opts.signal` and the watchdog
        // and the deadline are all absent, `turnSignal` is a non-aborted
        // composite that behaves as the no-signal regression guard requires.
        signal: turnSignal,
        // US-002 AC14: forward an onWaiting callback the batch can hand to
        // every coding-tool request. Wired in US-004 to emit the keepalive
        // activity; today it is a no-op so the field plumbing is real in the
        // production native path even though the keepalive is not yet
        // active. The handler copies it onto the tool's `ToolCallContext`
        // and a tool that blocks on a human approval calls it before the wait.
        onWaiting: () => {},
        pricingSource,
        onActivity: (activity) => {
          hooks?.onStreamActivity?.(buildNativeStreamEvent(eventBase, activity, Date.now()));
        },
        summarize: async (span, previousSummary) => {
          // Same model, same clock, no tools. The prompt asks for what a coding
          // agent needs back: what was tried, what was rejected and why, and the
          // files touched -- without them the agent re-reads what it already read.
          const remainingMs = deadline.remainingMs();
          const controller = new AbortController();
          const timer =
            remainingMs !== undefined ? _adapterDeps.setTimeout(() => controller.abort(), remainingMs) : undefined;
          // US-002: the per-call signal still combines with the per-turn signal
          // (watchdog + deadline + caller), so a turn cancel ends the summary
          // even mid-call. The per-call timer is the additional budget on top.
          const signal = AbortSignal.any(
            opts.signal !== undefined
              ? [opts.signal, controller.signal, turnController.signal, deadlineController.signal]
              : [controller.signal, turnController.signal, deadlineController.signal],
          );
          try {
            const res = await client.complete(resolved, {
              messages: [...span, { role: "user", content: summaryPrompt(previousSummary) }],
              sessionId,
              signal,
            });
            const summaryUsage = res.usage;
            const { costUsd, resolvedRates } = priceCall(summaryUsage, rates);
            return { text: res.text, usage: summaryUsage, costUsd, rates: resolvedRates };
          } finally {
            if (timer !== undefined) _adapterDeps.clearTimeout(timer);
          }
        },
        complete: async (messages, tools, requestOptions) => {
          // The controller is armed with what is LEFT of the turn, so N
          // round-trips can no longer add up to N x timeoutSeconds. Still
          // combined with any caller-supplied opts.signal via AbortSignal.any so
          // either can end the call. US-002: also combined with the per-turn
          // turnController + deadlineController signals so an in-flight call
          // observes the same cancellation the batch sees between calls.
          const remainingMs = deadline.remainingMs();
          const controller = new AbortController();
          const timer =
            remainingMs !== undefined ? _adapterDeps.setTimeout(() => controller.abort(), remainingMs) : undefined;
          const signal = AbortSignal.any(
            opts.signal !== undefined
              ? [opts.signal, controller.signal, turnController.signal, deadlineController.signal]
              : [controller.signal, turnController.signal, deadlineController.signal],
          );
          // The loop-event bag speaks in booleans: `false` explicitly drops
          // the session's inherited thinking level for this request, while
          // `true` leaves that resolved level in place. nax-ai accepts a
          // thinking LEVEL rather than a boolean, so normalize at this boundary.
          const requestThinking = requestOptions?.thinking === false ? undefined : thinking;

          try {
            const res = await client.complete(resolved, {
              messages,
              ...(tools.length > 0 ? { tools } : {}),
              sessionId,
              signal,
              ...(requestThinking !== undefined ? { thinking: requestThinking } : {}),
              ...(requestOptions?.temperature !== undefined ? { temperature: requestOptions.temperature } : {}),
              // nax#1835: "short" is fixed, not config-driven (this repo's
              // precedent -- the compaction design -- rejects knobs added
              // before evidence). The turn loop's round trips are seconds
              // apart, so "short" already hits; "long" would only pay off for
              // a later turn and bills more at write time for a window this
              // turn does not need. Only this round-trip closure sets it: the
              // one-shot complete() and the summarize closure below have no
              // successor turn (or, for summarize, a shape unlikely to repeat)
              // to reuse the entry, so a cache write there costs more than it
              // saves.
              cacheRetention: "short",
            });
            const usage = res.usage;
            // Single `priceCall` invocation: `costUsd` and `resolvedRates`
            // come from the same call so they cannot diverge — the
            // verifiability property the story names ("recorded rates
            // reproduce recorded cost") would silently break if tier
            // selection ever grew a side channel.
            const { costUsd, resolvedRates } = priceCall(usage, rates);
            return {
              text: res.text,
              ...(res.toolCalls !== undefined ? { toolCalls: res.toolCalls } : {}),
              ...(res.thinking !== undefined ? { thinking: res.thinking } : {}),
              usage,
              costUsd,
              // US-002: thread the per-call resolved rates back to
              // `runNativeTurn` so it can stamp them on the `TurnResult`.
              // The last round-trip's rates win — each round-trip re-prices
              // on its own usage, and the most recent decision is what
              // affected the user's last-mile spend.
              rates: resolvedRates,
            };
          } finally {
            if (timer !== undefined) _adapterDeps.clearTimeout(timer);
          }
        },
      });
    } catch (err) {
      hooks?.onStreamActivity?.({
        ...eventBase,
        kind: "agent.call_ended",
        status: turnController.signal.aborted ? "cancelled" : "error",
        timestamp: Date.now(),
      });
      markNativeTurnOutcome(this.state, handle.id, true);
      // The same treatment complete() gives a protocol fault, on the path that
      // was missing it (nax#1838). Rethrowing untouched left build-hop-callback
      // to synthesise a generic fail-adapter-error, which cost a rate limit its
      // backoff and an auth failure its unavailable mark.
      //
      // nax#1840: classification and cost are read off two different error
      // classes, and a throw can only be one. SessionTurnError is the carrier
      // both hop callbacks already read cost off, so it now also carries the
      // classification (its optional adapterFailure field) — one throw, both
      // facts. runNativeTurn attaches whatever was already spent on earlier
      // round trips to this same err before it reaches here; read it back
      // rather than dropping it as the pre-#1840 SessionFailureError did.
      //
      // Only a protocol fault is wrapped. A TypeError from our own code is not a
      // vendor failure, and dressing it as one would hide the bug.
      if (isProtocolStreamError(err)) {
        const adapterFailure = toAdapterFailure(err.protocolError);
        const usage = readNativeTurnFailureUsage(err);
        throw new SessionTurnError(
          err.protocolError.message,
          false,
          adapterFailure.retriable,
          usage?.tokenUsage,
          usage?.costUsd,
          undefined,
          // pricingSource — the native protocol-fault path has no rate card
          // to name here; left undefined (SessionTurnError.pricingSource).
          undefined,
          adapterFailure,
        );
      }
      throw err;
    } finally {
      if (deadlineTimer !== undefined) _adapterDeps.clearTimeout(deadlineTimer);
    }

    hooks?.onStreamActivity?.({
      ...eventBase,
      kind: "agent.call_ended",
      status: result.timedOut === true ? "timeout" : turnController.signal.aborted ? "cancelled" : "success",
      timestamp: Date.now(),
    });
    markNativeTurnOutcome(this.state, handle.id, false);
    // US-006: the store only observes `provider` while a request is in flight,
    // so the stamp is read here, after the loop.
    return { ...result, ...authFields(provider, this.ownStore) };
  }

  closeSession(handle: SessionHandle): Promise<void> {
    // The adapter interface has no failure signal, so the verdict comes from the
    // session's last turn (markNativeTurnOutcome) rather than from this call.
    // Passing a literal false here is what deleted the transcript of a failed
    // session -- the one the retry reloads and a human reads (nax#1838).
    return closeNativeSession(this.state, handle);
  }

  /**
   * Run teardown addresses a session the process no longer has a handle for,
   * by id string (execution/session-manager-runtime.ts). Without this the
   * native maps were unreachable at teardown: every `keepOpen` session was
   * removed from SessionManager._sessions by closeStory while its nine entries
   * stayed behind for the process lifetime.
   *
   * The ACP contract takes a handle string and closeNativeSession takes a
   * SessionHandle, but this adapter's state is keyed by the session-name string
   * both carry, so clear by name rather than synthesising a handle.
   */
  async closePhysicalSession(
    handle: string,
    _workdir?: string,
    _options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    return closeNativeSession(this.state, { id: handle, agentName: NATIVE_AGENT });
  }
}
