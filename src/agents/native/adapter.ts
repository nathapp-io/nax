/**
 * The native AgentAdapter: one-shot completions over nax-ai, no subprocess.
 *
 * Members that describe a process are answered honestly rather than faked:
 * there is no binary, no command and no pid. openSession/closeSession are
 * transcript-file bookkeeping, and sendTurn maps the native turn loop
 * (session/turn-loop.ts) over complete() — nax owns the conversation because
 * nax-ai's client is stateless (ADR-027 section 10, ADR-028).
 */

import { randomUUID } from "node:crypto";
import type { OpenSessionOpts, SendTurnOpts, SessionHandle, TurnResult } from "@/agents/session-types";
import type { AgentAdapter, AgentCapabilities, CompleteResult, ResolvedCompleteOptions } from "@/agents/types";
import { getSafeLogger } from "@/logger";
import { createTurnDeadline } from "../turn-deadline";
// Value import via the sibling path, matching acp/adapter.ts: the parent barrel
// would close an import cycle (agents/index -> registry -> native/index -> here).
import { SessionTurnError } from "../types";
import { anyAmbientCredential, listStoredProviders } from "./auth";
import { getNativeClient } from "./client";
import { toAdapterFailure } from "./errors";
import {
  buildRateCard,
  estimateCostUsd,
  NATIVE_AGENT,
  parseNativeModel,
  resolveContextWindow,
  toNaxTokenUsage,
  toThinkingLevel,
} from "./models";
import {
  closeNativeSession,
  markNativeTurnOutcome,
  nativeSessionCompaction,
  nativeSessionStreamHooks,
  nativeSessionTimeouts,
  openNativeSession,
} from "./session/session";
import { buildNativeStreamEvent } from "./session/turn-events";
import { readNativeTurnFailureUsage, runNativeTurn } from "./session/turn-loop";
import { nativeSessionId, newSessionKey } from "./session-affinity";

/** Conservative until capabilities become model-derived (ADR-027 Open Question 3). */
const CONSERVATIVE_CONTEXT_TOKENS = 128_000;

/**
 * Fallback whole-turn budget when a session's timeout entry is missing.
 *
 * Matches `execution.sessionTimeoutSeconds`' own default. The turn MUST stay
 * bounded: an absent entry previously degraded to an unbounded deadline with
 * no per-call timer either, silently removing the guard this module exists to
 * apply. Bounded-and-logged beats unbounded-and-quiet.
 */
const FALLBACK_TURN_TIMEOUT_SECONDS = 3600;

function isProtocolStreamError(err: unknown): err is { protocolError: { kind: string; message: string } } {
  return typeof err === "object" && err !== null && "protocolError" in err;
}

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

/** The builtin names, used when the adapter is built without config. */
const DEFAULT_TIERS: readonly string[] = ["fast", "balanced", "powerful"];

/** Test seam, following the _clientDeps precedent. */
export const _adapterDeps = { listStoredProviders, anyAmbientCredential };

export class NativeAgentAdapter implements AgentAdapter {
  readonly name = NATIVE_AGENT;
  readonly displayName = "Native (nax-ai)";
  /** Nothing to spawn. Not a placeholder — the absence is the fact. */
  readonly binary = "";
  readonly capabilities: AgentCapabilities;

  /**
   * `supportedTiers` comes from config because native's tiers are whatever
   * `models.native` names — arbitrary strings, not the three builtins
   * (ADR-027 section 5). An empty array would be actively wrong: the execution
   * stage clamps an unsupported tier to `supportedTiers[0]`, and with none it
   * logs a tier mismatch on every story. The config-less listing path passes
   * nothing and gets the builtins, matching the approximation the ADR already
   * documents for `getAllAgents`.
   */
  /**
   * Session key for the sessionless `complete()` path, per adapter instance.
   *
   * The agent registry caches one adapter per agent name for its own
   * lifetime, and a registry is built once per runtime — so this key's grain is
   * a run, which is the right one: a run's one-shots share a backend and keep a
   * cache warm, while two concurrent runs stay distinct.
   */
  private readonly oneShotKey = newSessionKey();

  constructor(supportedTiers: readonly string[] = DEFAULT_TIERS) {
    this.capabilities = {
      supportedTiers: supportedTiers.length > 0 ? supportedTiers : DEFAULT_TIERS,
      maxContextTokens: CONSERVATIVE_CONTEXT_TOKENS,
      // Explicitly typed, like AcpAgentAdapter does, rather than relying on
      // inference from a literal array.
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    };
  }

  /**
   * Always true: the native agent runs in-process. There is no binary, so
   * there is nothing to install, and "not installed" would be a false
   * answer to a question about presence.
   *
   * Deliberately NOT delegating to hasCredentials(). Whether a credential
   * exists is a different question, and AgentManager.validateCredentials()
   * is the place that asks it. Conflating them made checkAgentHealth()
   * report "not installed" for something that is always present.
   */
  async isInstalled(): Promise<boolean> {
    return true;
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
   * Errors resolve to true. Pruning an agent that would have worked kills a
   * run; the opposite costs one request-time error that is already handled.
   */
  async hasCredentials(): Promise<boolean> {
    try {
      if ((await _adapterDeps.listStoredProviders()).length > 0) return true;
      return await _adapterDeps.anyAmbientCredential();
    } catch {
      return true;
    }
  }

  /** Dry-run display shows no process, because there is none. */
  buildCommand(): string[] {
    return [];
  }

  async complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult> {
    // modelDef.provider is deliberately ignored. resolveModel() INFERS it from
    // the model name for string entries ("claude..." -> anthropic, else
    // "unknown"), so it is a guess rather than configuration — and routing a
    // billed call on a guess is what the protocol gate exists to prevent. The
    // string is the only source of truth.
    const { provider, model, effort } = parseNativeModel(options.modelDef.model);
    const thinking = toThinkingLevel(effort);
    const client = await getNativeClient();
    const resolved = await client.model(provider, model);

    const controller = new AbortController();
    const timer = options.timeoutMs !== undefined ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;

    try {
      const sessionId = nativeSessionId(this.oneShotKey);
      const result = await client.complete(resolved, {
        messages: [{ role: "user", content: prompt }],
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        sessionId,
        signal: controller.signal,
        ...(thinking !== undefined ? { thinking } : {}),
      });

      const tokenUsage = toNaxTokenUsage(result.usage);
      const catalog = client.pricing(resolved);
      const rates = buildRateCard(catalog, options.modelDef.pricing);

      return {
        output: result.text,
        tokenUsage,
        estimatedCostUsd: estimateCostUsd(tokenUsage, rates),
        // exactCostUsd is deliberately unset: nax-ai supplies rates and
        // computes no cost, so nothing here is exact.
        // sessionId echoes the one we sent — US-002 lets downstream wiring
        // (audit, dispatch) stamp it on artifacts without reaching into a
        // private field.
        sessionId,
      };
    } catch (err) {
      // Returned, not rethrown: rethrowing routes through
      // classifyCompleteException -> parseAgentError, which parses ACP strings
      // and would discard the typed kind nax-ai just gave us.
      if (isProtocolStreamError(err)) {
        return {
          output: "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          adapterFailure: toAdapterFailure(err.protocolError.kind),
        };
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
    return openNativeSession(name, opts);
  }

  async sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
    const { provider, model, effort } = parseNativeModel(handle.modelDef?.model ?? "");
    const thinking = toThinkingLevel(effort);
    const client = await getNativeClient();
    const resolved = await client.model(provider, model);
    const catalog = client.pricing(resolved);
    const rates = buildRateCard(catalog, handle.modelDef?.pricing);
    const storedTimeoutSeconds = nativeSessionTimeouts.get(handle.id);
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

    const hooks = nativeSessionStreamHooks.get(handle.id);
    // One callId per turn, mirroring SpawnAcpSession.prompt(). `runId` is
    // backfilled by the runtime's forwarding closure, which is the only place
    // that knows it — see runtime/index.ts.
    const callId = randomUUID();
    const eventBase = { callId, runId: "", agentName: handle.agentName, sessionName: handle.id };
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

    let result: TurnResult;
    try {
      result = await runNativeTurn(handle, prompt, opts, {
        deadline,
        contextWindow: resolveContextWindow(handle.modelDef?.contextWindow, resolved.contextWindow),
        ...(nativeSessionCompaction.get(handle.id) !== undefined
          ? { compaction: nativeSessionCompaction.get(handle.id) }
          : {}),
        onActivity: (activity) => {
          hooks?.onStreamActivity?.(buildNativeStreamEvent(eventBase, activity, Date.now()));
        },
        summarize: async (span, previousSummary) => {
          // Same model, same clock, no tools. The prompt asks for what a coding
          // agent needs back: what was tried, what was rejected and why, and the
          // files touched -- without them the agent re-reads what it already read.
          const remainingMs = deadline.remainingMs();
          const controller = new AbortController();
          const timer = remainingMs !== undefined ? setTimeout(() => controller.abort(), remainingMs) : undefined;
          const signal = AbortSignal.any(
            opts.signal !== undefined
              ? [opts.signal, controller.signal, turnController.signal]
              : [controller.signal, turnController.signal],
          );
          try {
            const res = await client.complete(resolved, {
              messages: [...span, { role: "user", content: summaryPrompt(previousSummary) }],
              sessionId,
              signal,
            });
            const summaryUsage = toNaxTokenUsage(res.usage);
            return { text: res.text, usage: summaryUsage, costUsd: estimateCostUsd(summaryUsage, rates) };
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        },
        complete: async (messages, tools) => {
          // The controller is armed with what is LEFT of the turn, so N
          // round-trips can no longer add up to N x timeoutSeconds. Still
          // combined with any caller-supplied opts.signal via AbortSignal.any so
          // either can end the call.
          const remainingMs = deadline.remainingMs();
          const controller = new AbortController();
          const timer = remainingMs !== undefined ? setTimeout(() => controller.abort(), remainingMs) : undefined;
          const signal = AbortSignal.any(
            opts.signal !== undefined
              ? [opts.signal, controller.signal, turnController.signal]
              : [controller.signal, turnController.signal],
          );

          try {
            const res = await client.complete(resolved, {
              messages,
              ...(tools.length > 0 ? { tools } : {}),
              sessionId,
              signal,
              ...(thinking !== undefined ? { thinking } : {}),
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
            const usage = toNaxTokenUsage(res.usage);
            return {
              text: res.text,
              ...(res.toolCalls !== undefined ? { toolCalls: res.toolCalls } : {}),
              ...(res.thinking !== undefined ? { thinking: res.thinking } : {}),
              usage,
              costUsd: estimateCostUsd(usage, rates),
            };
          } finally {
            if (timer !== undefined) clearTimeout(timer);
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
      markNativeTurnOutcome(handle.id, true);
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
        const adapterFailure = toAdapterFailure(err.protocolError.kind);
        const usage = readNativeTurnFailureUsage(err);
        throw new SessionTurnError(
          err.protocolError.message,
          false,
          adapterFailure.retriable,
          usage?.tokenUsage,
          usage?.costUsd,
          undefined,
          adapterFailure,
        );
      }
      throw err;
    }

    hooks?.onStreamActivity?.({
      ...eventBase,
      kind: "agent.call_ended",
      status: result.timedOut === true ? "timeout" : turnController.signal.aborted ? "cancelled" : "success",
      timestamp: Date.now(),
    });
    markNativeTurnOutcome(handle.id, false);
    return result;
  }

  closeSession(handle: SessionHandle): Promise<void> {
    // The adapter interface has no failure signal, so the verdict comes from the
    // session's last turn (markNativeTurnOutcome) rather than from this call.
    // Passing a literal false here is what deleted the transcript of a failed
    // session -- the one the retry reloads and a human reads (nax#1838).
    return closeNativeSession(handle);
  }
}
