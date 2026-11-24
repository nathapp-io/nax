/**
 * One-shot completion over nax-ai, with no session (S1 port 2). Package-owned
 * options: the caller passes a `SessionModel` whose pricing is already in the
 * standard vocabulary, and the per-adapter one-shot session key.
 */

import { priceCall } from "#src/cost/core/index";
import type { AdapterFailure } from "#src/session/adapter-failure";
import type { AuthStamp, SessionModel } from "#src/session/session-types";
import type { PricingRates, TokenUsage } from "../cost/standard-types.ts";
import { _adapterDeps, authFields, isProtocolStreamError } from "./adapter-deps.ts";
import { getNativeClient, type NativeCatalogOverrides } from "./client.ts";
import { toAdapterFailure } from "./errors.ts";
import { buildRateCard, parseNativeModel, toThinkingLevel } from "./models.ts";
import { nativeSessionId } from "./session-affinity.ts";

export interface NativeCompleteOptions {
  readonly model: SessionModel;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  /**
   * US-002: the caller's cancellation. A signal already aborted on entry
   * rejects with its own reason before any client work; an abort while the call
   * is in flight — including while the client is built or the model resolved —
   * cancels the request signal handed to `client.complete`.
   */
  readonly signal?: AbortSignal;
}

export interface NativeCompleteContext {
  readonly catalogOverrides: NativeCatalogOverrides;
  /**
   * The caller's one-shot session key (`newSessionKey()`), held per adapter
   * instance so a run's one-shots share a backend and keep a cache warm.
   */
  readonly sessionKey: string;
}

export interface NativeCompleteResult {
  output: string;
  tokenUsage: TokenUsage;
  estimatedCostUsd: number;
  sessionId?: string;
  pricingSource?: "catalog-rates" | "config-override";
  rates?: PricingRates;
  auth?: AuthStamp;
  adapterFailure?: AdapterFailure;
}

export async function nativeComplete(
  prompt: string,
  options: NativeCompleteOptions,
  context: NativeCompleteContext,
): Promise<NativeCompleteResult> {
  const callerSignal = options.signal;
  // A caller that gave up before the call started rejects with ITS reason —
  // before any client work, because building the client loads the whole
  // catalog and a cancelled request must not pay for that.
  if (callerSignal?.aborted === true) throw abortReason(callerSignal);

  // modelDef.provider is deliberately ignored. resolveModel() INFERS it from
  // the model name for string entries ("claude..." -> anthropic, else
  // "unknown"), so it is a guess rather than configuration — and routing a
  // billed call on a guess is what the protocol gate exists to prevent. The
  // string is the only source of truth.
  const { provider, model, effort } = parseNativeModel(options.model.model);
  const thinking = toThinkingLevel(effort);
  const cancellation = callCancellation(callerSignal);

  try {
    const client = await getNativeClient(context.catalogOverrides);
    const resolved = await client.model(provider, model);
    cancellation.armTimeout(options.timeoutMs);

    const sessionId = nativeSessionId(context.sessionKey);
    const result = await client.complete(resolved, {
      messages: [{ role: "user", content: prompt }],
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      sessionId,
      signal: cancellation.signal,
      ...(thinking !== undefined ? { thinking } : {}),
    });

    const tokenUsage = result.usage;
    const catalog = client.pricing(resolved);
    const { rates, source: pricingSource } = buildRateCard(catalog, options.model.pricing);
    // US-002: stamp the effective `priceCall`-resolved rates so the cost
    // subscriber can record the same numbers whose arithmetic reproduces
    // `estimatedCostUsd`. The native path prices unconditionally — even
    // a zero-token call carries `rates`, so a downstream cost row never
    // has to guess what priced a no-spend dispatch.
    //
    // Single `priceCall` invocation: `costUsd` and `resolvedRates` come
    // from the same call so they cannot diverge — the verifiability
    // property the story names ("recorded rates reproduce recorded cost")
    // would silently break if tier selection ever grew a side channel.
    const { costUsd: estimatedCostUsd, resolvedRates } = priceCall(tokenUsage, rates);

    return {
      output: result.text,
      tokenUsage,
      estimatedCostUsd,
      // exactCostUsd is deliberately unset: nax-ai supplies rates and
      // computes no cost, so nothing here is exact.
      // sessionId echoes the one we sent — US-002 lets downstream wiring
      // (audit, dispatch) stamp it on artifacts without reaching into a
      // private field.
      sessionId,
      // US-003: stamp the branch buildRateCard took so cost rows can tell a
      // catalog-priced call from a config-overridden one. Single source of
      // truth — the same override !== undefined predicate the rate card was
      // chosen on, reported rather than re-derived by the cost subscriber.
      pricingSource,
      // US-002: the four per-1M rates that priced this call. See
      // NativeCompleteResult.rates above.
      rates: resolvedRates,
      // US-006: the credential identity the store observed while serving
      // this call. Absent (not undefined) when it observed nothing.
      ...authFields(provider),
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
        adapterFailure: toAdapterFailure(err.protocolError),
      };
    }
    throw err;
  } finally {
    cancellation.release();
  }
}

/**
 * The error an abort surfaces: the caller's own reason, or an `AbortError` when
 * it carried none.
 *
 * `undefined` is the only absent reason. An explicit `abort(null)` states a
 * reason of its own (the spec stores whatever `abort()` was given), so a
 * nullish test here would silently replace it with a synthesised error the
 * caller never asked for.
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined ? new DOMException("Aborted", "AbortError") : signal.reason;
}

/**
 * The cancellation lifecycle of one one-shot call (US-002): a single controller
 * for the request signal, aborted by whichever of the caller's signal or the
 * call's timeout fires first.
 *
 * Wired synchronously, before the first `await`, because `getNativeClient` can
 * spend real time building the catalog. A listener registered after it would
 * miss an abort that landed in that gap, and the signal handed to
 * `client.complete` is this controller's either way — so an abort during the
 * client build or the model lookup still reaches the request.
 *
 * `armTimeout` covers the request itself; `release` is the one teardown, called
 * from the caller's `finally` so a rejection from `getNativeClient` or
 * `client.model` also detaches the listener and clears the timer, leaving the
 * caller's signal no reference to a call that already ended.
 */
function callCancellation(callerSignal: AbortSignal | undefined): {
  readonly signal: AbortSignal;
  armTimeout(timeoutMs: number | undefined): void;
  release(): void;
} {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", onCallerAbort);

  // Typed `unknown` like the seam it comes from: the handle is opaque, and only
  // `_adapterDeps.clearTimeout` may read it.
  let timer: unknown;
  return {
    signal: controller.signal,
    armTimeout(timeoutMs) {
      if (timeoutMs !== undefined) timer = _adapterDeps.setTimeout(() => controller.abort(), timeoutMs);
    },
    release() {
      if (timer !== undefined) _adapterDeps.clearTimeout(timer);
      timer = undefined;
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
