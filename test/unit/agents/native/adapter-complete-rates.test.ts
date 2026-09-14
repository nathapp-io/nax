/**
 * US-002 — Native adapter stamps the effective `priceCall`-resolved rates on
 * `CompleteResult.rates`, so the cost subscriber can record the same numbers
 * whose arithmetic reproduces the row's `estimatedCostUsd`.
 *
 * Acceptance criteria covered:
 *   AC1 — native `complete()` for a priced call: `CompleteResult.rates` has
 *          four fields equal to the effective rates used to price the call.
 *   AC4 — native `complete()` with a tiered rate card and usage crossing the
 *          tier threshold: returned `CompleteResult.rates` equals the
 *          winning tier's rates, not the card's base rates.
 *   AC6 — native `complete()` for zero input and zero output tokens:
 *          returned `CompleteResult` still carries `rates` because the
 *          native path prices unconditionally (no nonzero-usage guard).
 *
 * The tests drive the real `NativeAgentAdapter.complete()` path through a
 * fake `nax-ai` client whose `pricing()` returns the card the test wants to
 * exercise, and assert on `CompleteResult.rates` after a priced call. The
 * fake client's `usage` is independent of the card so each test can vary
 * the rate values without touching the token totals.
 *
 * Stub note: `CompleteResult.rates` does not yet exist. The implementer
 * must declare the field on the interface and stamp `priceCall`'s
 * `resolvedRates` onto every priced `CompleteResult` in
 * `NativeAgentAdapter.complete()`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Pricing, ResolvedModel } from "@nathapp/nax-ai";
import { _adapterDeps, NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import type { ResolvedCompleteOptions } from "@/agents/types";

const REAL_BUILD = _clientDeps.build;
const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
});

function makeOptions(): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all" },
  };
}

/** Build a native client whose pricing() returns the requested `Pricing` and
 *  whose complete() reports the given usage. The model resolves cleanly. */
function stubClient(pricing: Pricing, usage: { inputTokens: number; outputTokens: number }) {
  const MODEL = {
    id: "gpt-5.4-mini",
    provider: "openai",
    protocol: "openai-responses",
    pricing,
    contextWindow: 128_000,
    supportsTools: true,
    thinkingLevels: [],
  } satisfies ResolvedModel;
  return async () => ({
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => pricing,
    stream: async function* stream() {},
    complete: async () => ({
      text: "ok",
      usage,
      stopReason: "stop" as const,
    }),
    validate: () => {},
  });
}

describe("NativeAgentAdapter.complete() — CompleteResult.rates propagation (US-002)", () => {
  // AC1 (success): a priced call returns the four-field ResolvedRates whose
  // values match the effective rates that priced it (no tier crossing ->
  // the base catalog rates, with cacheRead/cacheCreation defined).
  test("AC1: complete() returns rates.inputPer1M = catalog input rate and rates.outputPer1M = catalog output rate", async () => {
    _clientDeps.build = stubClient(
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    );

    const result = await new NativeAgentAdapter().complete("hi", makeOptions());

    // The catalog rates' inputPer1M and outputPer1M show up on the result
    // verbatim (no tier crossing -> the catalog's base rates win).
    expect(result.rates).toBeDefined();
    expect(result.rates?.inputPer1M).toBe(2);
    expect(result.rates?.outputPer1M).toBe(10);
  });

  // AC1 boundary: cacheRead/cacheCreation from the catalog are forwarded on
  // the result too. The story names "four fields" explicitly — pinning the
  // count keeps an implementer from dropping the cache legs.
  test("AC1 boundary: rates carries cacheReadPer1M and cacheCreationPer1M from the catalog", async () => {
    _clientDeps.build = stubClient(
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      { inputTokens: 100, outputTokens: 100 },
    );

    const result = await new NativeAgentAdapter().complete("hi", makeOptions());

    expect(result.rates?.cacheReadPer1M).toBe(0.2);
    expect(result.rates?.cacheCreationPer1M).toBe(2.5);
    expect(Object.keys(result.rates ?? {}).sort()).toEqual([
      "cacheCreationPer1M",
      "cacheReadPer1M",
      "inputPer1M",
      "outputPer1M",
    ]);
  });

  // AC4 (success): with a tier above the threshold, the winning tier's rates
  // (NOT the card's base rates) reach CompleteResult.rates. Two rates differ
  // between base and tier so a "drop tier, use base" regression would show
  // up here as the wrong numbers.
  test("AC4: complete() with a tiered card and usage crossing the threshold returns the winning tier's rates", async () => {
    // Tier applies above 100_000 input-class tokens. The adapter receives a
    // Pricing whose TIER inputPer1M=4, outputPer1M=20 — the upper values
    // the winner should expose.
    const pricing: Pricing = {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.0,
      tiers: [
        {
          input: 4,
          output: 20,
          cacheRead: 0.4,
          cacheWrite: 4.0,
          inputTokensAbove: 100_000,
        },
      ],
    };
    _clientDeps.build = stubClient(pricing, { inputTokens: 200_000, outputTokens: 0 });

    const result = await new NativeAgentAdapter().complete("hi", makeOptions());

    // 200_000 strictly exceeds 100_000, so the tier wins (the WHOLE request
    // re-prices on it). The base inputPer1M=1, outputPer1M=5 must NOT appear
    // on `rates`.
    expect(result.rates?.inputPer1M).toBe(4);
    expect(result.rates?.outputPer1M).toBe(20);
    // The tier declared its own cache rates; the winning row takes them
    // through (not the base rates' cacheRead/cacheCreation).
    expect(result.rates?.cacheReadPer1M).toBe(0.4);
    expect(result.rates?.cacheCreationPer1M).toBe(4.0);
  });

  // AC4 boundary: when usage lands EXACTLY on the threshold (not strictly
  // greater), the base rates win. The boundary pins the same comparison the
  // US-001 tier-selection tests pin — a regression that flipped the strict
  // comparison would surface here as the wrong winning row.
  test("AC4 boundary: usage exactly on the threshold uses the base rates, not the tier", async () => {
    const pricing: Pricing = {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.0,
      tiers: [
        {
          input: 4,
          output: 20,
          cacheRead: 0.4,
          cacheWrite: 4.0,
          inputTokensAbove: 100_000,
        },
      ],
    };
    _clientDeps.build = stubClient(pricing, { inputTokens: 100_000, outputTokens: 0 });

    const result = await new NativeAgentAdapter().complete("hi", makeOptions());

    expect(result.rates?.inputPer1M).toBe(1);
    expect(result.rates?.outputPer1M).toBe(5);
  });

  // AC6 (success): the native path prices unconditionally — zero input and
  // zero output still surface `rates` on the result. The ACP path puts a
  // nonzero-usage guard in front of pricing and omits `rates`; the native
  // path does not. Without a `rates` value, a downstream cost row cannot
  // recover the numbers whose arithmetic checked out.
  test("AC6: complete() with zero input and zero output carries rates (native prices unconditionally)", async () => {
    _clientDeps.build = stubClient(
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 1.5 },
      { inputTokens: 0, outputTokens: 0 },
    );

    const result = await new NativeAgentAdapter().complete("hi", makeOptions());

    expect(result.rates).toBeDefined();
    expect(result.rates?.inputPer1M).toBe(3);
    expect(result.rates?.outputPer1M).toBe(15);
    expect(result.rates?.cacheReadPer1M).toBe(0.3);
    expect(result.rates?.cacheCreationPer1M).toBe(1.5);
  });

  // AC1 verdict identity (cross-cut): the rates reported on `CompleteResult`
  // make the arithmetic of `estimatedCostUsd` check out — multiplying each
  // token class by its matching rate and summing equals the reported cost.
  // This is the property US-001 names as "what makes a cost row verifiable".
  test("AC1 verdict: sum(token/1M * rates field) equals reported estimatedCostUsd", async () => {
    _clientDeps.build = stubClient(
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      { inputTokens: 100, outputTokens: 50 },
    );

    const result = await new NativeAgentAdapter().complete("hi", makeOptions());

    const rates = result.rates;
    if (rates === undefined) throw new Error("expected rates on CompleteResult");

    // No cache tokens reported — the cache legs contribute zero.
    const expected = (100 / 1_000_000) * rates.inputPer1M + (50 / 1_000_000) * rates.outputPer1M;
    expect(result.estimatedCostUsd).toBeCloseTo(expected, 10);
  });
});
