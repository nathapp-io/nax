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
  // modelDef.provider is deliberately ignored. resolveModel() INFERS it from
  // the model name for string entries ("claude..." -> anthropic, else
  // "unknown"), so it is a guess rather than configuration — and routing a
  // billed call on a guess is what the protocol gate exists to prevent. The
  // string is the only source of truth.
  const { provider, model, effort } = parseNativeModel(options.model.model);
  const thinking = toThinkingLevel(effort);
  const client = await getNativeClient(context.catalogOverrides);
  const resolved = await client.model(provider, model);

  const controller = new AbortController();
  const timer =
    options.timeoutMs !== undefined ? _adapterDeps.setTimeout(() => controller.abort(), options.timeoutMs) : undefined;

  try {
    const sessionId = nativeSessionId(context.sessionKey);
    const result = await client.complete(resolved, {
      messages: [{ role: "user", content: prompt }],
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      sessionId,
      signal: controller.signal,
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
    if (timer !== undefined) _adapterDeps.clearTimeout(timer);
  }
}
