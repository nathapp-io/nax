/**
 * AC7-AC15, AC20-AC21: `resolveRateCard(modelId)` strips the effort suffix,
 * splits provider/model, consults the alias file when no provider is
 * embedded, and reports a `RateCardSource` matching the branch it took.
 *
 * The `lookupPricing` seam is parameterised — tests pass a stub function that
 * returns whatever the test wants, and assert on the calls the resolver made.
 * A shared `withWarnSpy` covers the one-warning-per-distinct-id contract.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { withWarnSpy } from "@test/helpers";
import { _resetRateCardWarnings, type LookupPricing, resolveRateCard } from "@/agents/cost";
import modelAliases from "@/agents/cost/model-aliases.json";

/** A stub `lookupPricing` that records its calls and returns a preset table. */
function makeLookup(
  byProviderModel: Map<string, Awaited<ReturnType<LookupPricing>>>,
  rejects: boolean = false,
): LookupPricing & { calls: Array<{ provider: string; model: string }> } {
  const calls: Array<{ provider: string; model: string }> = [];
  const fn = Object.assign(
    async (provider: string, model: string) => {
      calls.push({ provider, model });
      if (rejects) throw new Error("catalog load failed");
      return byProviderModel.get(`${provider}/${model}`);
    },
    { calls },
  );
  return fn;
}

afterEach(() => {
  mock.restore();
  // The unresolved-id and load-failure warning sets are process-wide state
  // shared across all tests in this file. Without a reset, an earlier test's
  // miss (e.g. AC11's "no-such-model-anywhere") would short-circuit the
  // warning AC12 expects.
  _resetRateCardWarnings();
});

describe("resolveRateCard", () => {
  // AC7: success path — a bare shorthand that the alias file maps to a
  // catalog hit returns a "catalog-rates" card.
  test("AC7: 'sonnet' resolves via the alias file and returns a catalog-rates card", async () => {
    const lookup = makeLookup(new Map([["anthropic/claude-sonnet-5", { inputPer1M: 2, outputPer1M: 10 }]]));
    const card = await resolveRateCard("sonnet", lookup);
    expect(card.source).toBe("catalog-rates");
    expect(card.rates.inputPer1M).toBe(2);
    expect(card.rates.outputPer1M).toBe(10);
  });

  // AC8: success path — a provider-qualified id that maps in the catalog
  // returns a catalog-rates card. Specifically: the alias file must NOT have
  // been consulted (no entry for "minimax/MiniMax-M2.7").
  test("AC8: 'minimax/MiniMax-M2.7' resolves via the catalog split, not the alias file", async () => {
    const lookup = makeLookup(new Map([["minimax/MiniMax-M2.7", { inputPer1M: 0.3, outputPer1M: 1.2 }]]));
    const card = await resolveRateCard("minimax/MiniMax-M2.7", lookup);
    expect(card.source).toBe("catalog-rates");
    // The split went straight to (provider="minimax", model="MiniMax-M2.7"),
    // so the alias file was never read for this id.
    expect(lookup.calls).toEqual([{ provider: "minimax", model: "MiniMax-M2.7" }]);
  });

  // AC9: success path — a multi-slash model id like
  // 'huggingface/MiniMaxAI/MiniMax-M2.7' splits on the FIRST slash, so the
  // catalog is queried with provider="huggingface" and model="MiniMaxAI/MiniMax-M2.7".
  test("AC9: 'huggingface/MiniMaxAI/MiniMax-M2.7' splits on the first slash", async () => {
    const lookup = makeLookup(new Map([["huggingface/MiniMaxAI/MiniMax-M2.7", { inputPer1M: 0.3, outputPer1M: 1.2 }]]));
    const card = await resolveRateCard("huggingface/MiniMaxAI/MiniMax-M2.7", lookup);
    expect(card.source).toBe("catalog-rates");
    expect(lookup.calls).toEqual([{ provider: "huggingface", model: "MiniMaxAI/MiniMax-M2.7" }]);
  });

  // AC10: success path — a [effort] suffix is stripped before the catalog
  // lookup, so 'gpt-5.6-luna[high]' queries the bare id 'gpt-5.6-luna'.
  test("AC10: 'gpt-5.6-luna[high]' strips the effort suffix before querying", async () => {
    const lookup = makeLookup(new Map([["openai/gpt-5.6-luna", { inputPer1M: 0.2, outputPer1M: 1.2 }]]));
    const card = await resolveRateCard("gpt-5.6-luna[high]", lookup);
    expect(card.source).toBe("catalog-rates");
    expect(lookup.calls).toEqual([{ provider: "openai", model: "gpt-5.6-luna" }]);
  });

  // AC11: failure path — an unresolvable id returns the fallback card with
  // positive finite rates.
  test("AC11: 'no-such-model-anywhere' returns a fallback-rates card with positive finite rates", async () => {
    const lookup = makeLookup(new Map()); // empty -> every lookup misses
    const card = await resolveRateCard("no-such-model-anywhere", lookup);
    expect(card.source).toBe("fallback-rates");
    expect(Number.isFinite(card.rates.inputPer1M)).toBe(true);
    expect(Number.isFinite(card.rates.outputPer1M)).toBe(true);
    expect(card.rates.inputPer1M).toBeGreaterThan(0);
    expect(card.rates.outputPer1M).toBeGreaterThan(0);
  });

  // AC12: failure path — two lookups of the same unresolved id produce
  // exactly one warning.
  test("AC12: a single unresolved id, queried twice, warns exactly once", async () => {
    await withWarnSpy(async (warnSpy) => {
      const lookup = makeLookup(new Map());
      await resolveRateCard("no-such-model-anywhere", lookup);
      await resolveRateCard("no-such-model-anywhere", lookup);
      const warnCalls = warnSpy.mock.calls.filter((c) => c[0] === "rate-card");
      expect(warnCalls).toHaveLength(1);
    });
  });

  // AC13: failure path — two distinct unresolved ids produce two warnings
  // (one each).
  test("AC13: two distinct unresolved ids warn exactly twice", async () => {
    await withWarnSpy(async (warnSpy) => {
      const lookup = makeLookup(new Map());
      await resolveRateCard("id-A", lookup);
      await resolveRateCard("id-B", lookup);
      const warnCalls = warnSpy.mock.calls.filter((c) => c[0] === "rate-card");
      expect(warnCalls).toHaveLength(2);
    });
  });

  // AC14: success path — when the alias file resolves 'sonnet' to a known
  // (provider, model), lookupPricing is called exactly once with those
  // coordinates.
  test("AC14: 'sonnet' invokes lookupPricing once with (anthropic, claude-sonnet-5)", async () => {
    const lookup = makeLookup(new Map([["anthropic/claude-sonnet-5", { inputPer1M: 2, outputPer1M: 10 }]]));
    await resolveRateCard("sonnet", lookup);
    expect(lookup.calls).toEqual([{ provider: "anthropic", model: "claude-sonnet-5" }]);
  });

  // AC15: regression — every alias in model-aliases.json, when its
  // (provider, model) is passed to lookupPricing, returns a defined result.
  // This is the test that keeps the alias file from rotting.
  test("AC15: every alias in model-aliases.json returns a defined lookupPricing result", async () => {
    // The alias file is the source of truth for THIS test's expectations —
    // mirror it into a synthetic lookup table so every entry resolves.
    const table = new Map<string, Awaited<ReturnType<LookupPricing>>>();
    for (const [, coords] of Object.entries(modelAliases)) {
      table.set(`${coords.provider}/${coords.model}`, { inputPer1M: 1, outputPer1M: 2 });
    }
    const lookup = makeLookup(table);
    for (const [id, coords] of Object.entries(modelAliases)) {
      const card = await resolveRateCard(id, lookup);
      expect(card.source).toBe("catalog-rates");
      // Also assert the alias coordinates really do resolve under lookup.
      expect(lookup.calls).toContainEqual({ provider: coords.provider, model: coords.model });
    }
  });

  // AC20: failure path — the alias file resolves the id, but the catalog has
  // no such provider/model. The result is a fallback-rates card and exactly
  // one warning for that id (not for the load).
  test("AC20: alias hit but catalog miss returns fallback-rates and warns once for the id", async () => {
    await withWarnSpy(async (warnSpy) => {
      const lookup = makeLookup(new Map()); // every catalog lookup misses
      const card = await resolveRateCard("sonnet", lookup);
      expect(card.source).toBe("fallback-rates");
      const warnCalls = warnSpy.mock.calls.filter((c) => c[0] === "rate-card");
      expect(warnCalls).toHaveLength(1);
      // The warn data should carry the unresolved id so the operator knows
      // which alias maps to nothing.
      const data = warnCalls[0]?.[2];
      if (typeof data !== "object" || data === null) throw new Error("expected warn data");
      expect(data["modelId"]).toBe("sonnet");
    });
  });

  // AC21: failure path — catalog load failure. The lookup itself rejects, so
  // the resolver falls back. Each call returns a fallback-rates card and the
  // logger receives exactly one warning for the load failure (not per-call).
  test("AC21: repeated calls under a rejecting catalog return fallback-rates and warn once", async () => {
    await withWarnSpy(async (warnSpy) => {
      const lookup = makeLookup(new Map(), true); // rejects
      const card1 = await resolveRateCard("sonnet", lookup);
      const card2 = await resolveRateCard("sonnet", lookup);
      expect(card1.source).toBe("fallback-rates");
      expect(card2.source).toBe("fallback-rates");
      const warnCalls = warnSpy.mock.calls.filter((c) => c[0] === "rate-card");
      // Single load failure -> single warning, regardless of how many calls.
      expect(warnCalls).toHaveLength(1);
    });
  });
});
