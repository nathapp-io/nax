/**
 * The one summarizer every native compaction path shares (US-002).
 *
 * `sendTurn` built this closure inline until manual compaction needed the same
 * call: same model, same clock, no tools, the same prompt asking for what a
 * coding agent needs back — what was tried, what was rejected and why, the files
 * touched — plus the same per-call budget and the same pricing. Two copies would
 * have drifted on exactly the details that are invisible when they do (the
 * thinking level, the rate card branch, the merge instruction), so the closure
 * and the per-session resolution it depends on live here once.
 *
 * `resolveSessionModel` is the other half of that sharing: `sendTurn` and
 * `compactHistory` must agree on the model, the rate card, the context window
 * and the compaction settings, and they now do so by construction. The window
 * and the settings are not used by the closure itself — they are what the caller
 * hands the turn loop or the keep-budget maths, and resolving them alongside the
 * client is what keeps one session's five facts from being assembled two ways.
 *
 * This module deliberately does NOT import a second site of `@nathapp/nax-ai`
 * beyond the client types it is handed: the client arrives already built.
 */
import type { Client, ResolvedModel, ThinkingLevel } from "@nathapp/nax-ai";
import { priceCall } from "#src/cost/core/index";
import type { Pricing } from "#src/cost/standard-types";
import type { SessionHandle } from "#src/session/session-types";
import type { TurnDeadline } from "#src/session/turn-deadline";
import { _adapterDeps } from "../adapter-deps.ts";
import { buildRateCard, parseNativeModel, resolveContextWindow, toThinkingLevel } from "../models.ts";
import { nativeSessionId } from "../session-affinity.ts";
import type { ResolvedCompaction } from "./compaction.ts";
import { DEFAULT_COMPACTION } from "./compaction-settings.ts";
import type { NativeSessionState } from "./session.ts";
import type { TurnDeps } from "./turn-types.ts";

/**
 * Everything one session's model call needs, resolved once per operation.
 *
 * `compaction` falls back to `DEFAULT_COMPACTION` rather than staying absent:
 * an adapter whose open did not carry settings (an embedder that never set them)
 * still answers "what is the keep budget" the way every other caller does. The
 * automatic path's `TurnDeps.compaction` stays optional-and-absent for such a
 * session — see the adapter's own note — because there "no settings" and
 * "settings that disable compaction" must remain distinguishable.
 */
export interface SessionModelResolution {
  readonly client: Client;
  readonly model: ResolvedModel;
  /** The provider half of the model id, as parsed (`authFields` needs it). */
  readonly provider: string;
  /** The request-side reasoning level the session's effort suffix translates to. */
  readonly thinking: ThinkingLevel | undefined;
  /** The rate card `priceCall` prices from: the config override, or the catalog. */
  readonly rates: Pricing;
  readonly pricingSource: "catalog-rates" | "config-override";
  /** The window compaction counts against (`resolveContextWindow`). */
  readonly contextWindow: number;
  readonly compaction: ResolvedCompaction;
  /** The provider-facing session id every call of this session carries. */
  readonly sessionId: string;
}

/** Resolve the session's model facts. Throws on a malformed model id, as `sendTurn` always has. */
export async function resolveSessionModel(
  client: Client,
  state: NativeSessionState,
  handle: SessionHandle,
): Promise<SessionModelResolution> {
  const { provider, model, effort } = parseNativeModel(handle.modelDef?.model ?? "");
  const resolved = await client.model(provider, model);
  const { rates, source } = buildRateCard(client.pricing(resolved), handle.modelDef?.pricing);
  return {
    client,
    model: resolved,
    provider,
    thinking: toThinkingLevel(effort),
    rates,
    pricingSource: source,
    contextWindow: resolveContextWindow(handle.modelDef?.contextWindow, resolved.contextWindow),
    compaction: state.compaction.get(handle.id) ?? DEFAULT_COMPACTION,
    sessionId: nativeSessionId(handle.id),
  };
}

/**
 * What the summary call is asked for. Moved here unchanged from the adapter:
 * the merge instruction is part of the summarizer's contract, not of the turn
 * that happens to trigger it.
 */
export function summaryPrompt(previousSummary?: string): string {
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

export interface SessionSummarizerInput {
  readonly resolution: SessionModelResolution;
  /** What is LEFT of the operation's budget, consulted per call. */
  readonly deadline: TurnDeadline;
  /**
   * The operation's cancellation, already composed: for a turn that is the
   * per-turn signal (caller + watchdog + deadline), for a manual compaction the
   * facade's deadline and close signal. The per-call budget is fanned in here.
   */
  readonly signal: AbortSignal;
}

/** The `summarize` closure both `sendTurn` and `compactHistory` hand the compaction core. */
export function createSessionSummarizer(input: SessionSummarizerInput): NonNullable<TurnDeps["summarize"]> {
  const { resolution, deadline, signal } = input;
  return async (span, previousSummary) => {
    const remainingMs = deadline.remainingMs();
    const controller = new AbortController();
    const timer =
      remainingMs !== undefined ? _adapterDeps.setTimeout(() => controller.abort(), remainingMs) : undefined;
    // The per-call signal combines the operation's cancellation with this
    // call's remaining budget, so a cancel ends the summary even mid-call.
    const callSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const res = await resolution.client.complete(resolution.model, {
        messages: [...span, { role: "user", content: summaryPrompt(previousSummary) }],
        sessionId: resolution.sessionId,
        signal: callSignal,
        // A summary restates the transcript; it does not need reasoning.
        // "off", not an absent level: absent means the backend default,
        // which on a model that cannot disable thinking is adaptive at
        // effort high (#2686). The client clamps "off" to the least
        // thinking such a model allows.
        thinking: "off",
      });
      const { costUsd, resolvedRates } = priceCall(res.usage, resolution.rates);
      return {
        text: res.text,
        usage: res.usage,
        costUsd,
        rates: resolvedRates,
      };
    } finally {
      if (timer !== undefined) _adapterDeps.clearTimeout(timer);
      // #2846: release the per-call signal, which the operation's longer-lived signal would
      // otherwise keep reachable while it carries listeners. The call has settled.
      controller.abort();
    }
  };
}
