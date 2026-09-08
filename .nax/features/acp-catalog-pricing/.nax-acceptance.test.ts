import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateCostUsd, resolvePricingSource } from "@/agents/cost";
import { _acpAdapterDeps, AcpAgentAdapter } from "@/agents/acp/adapter";
import { buildTurnResult } from "@/agents/acp/adapter-output";
import { attachCostSubscriber } from "@/runtime/middleware/cost";
import { _catalogPricingDeps, lookupPricing, resolveRateCard } from "@/agents/cost/catalog";
import aliases from "@/agents/cost/model-aliases.json";

const positiveCard = { rates: { inputPer1M: 2, outputPer1M: 10 }, source: "catalog-rates" as const };
let originalCatalogDeps: Record<string, unknown>;
let originalAcpDeps: Record<string, unknown>;

function clientWith(session: any) {
  return { start: async () => {}, createSession: async () => session, loadSession: async () => null, close: async () => {}, cancelActivePrompt: async () => {} };
}
function completeOptions() {
  return { modelDef: { provider: "anthropic", model: "sonnet", env: {} }, workdir: "/tmp/catalog-pricing", resolvedPermissions: { mode: "approve-reads" } } as any;
}
function openOptions() {
  return { agentName: "claude", workdir: "/tmp/catalog-pricing", modelDef: { provider: "anthropic", model: "sonnet", env: {} }, modelTier: "balanced", timeoutSeconds: 60, resolvedPermissions: { mode: "approve-reads" } } as any;
}
function successfulSession() {
  return { prompt: async () => ({ messages: [{ role: "assistant", content: "ok" }], stopReason: "end_turn", cumulative_token_usage: { input_tokens: 1, output_tokens: 1 } }), close: async () => {}, cancelActivePrompt: async () => {} };
}

beforeEach(() => {
  originalCatalogDeps = { ...(_catalogPricingDeps as Record<string, unknown>) };
  originalAcpDeps = { ...(_acpAdapterDeps as Record<string, unknown>) };
  _catalogPricingDeps.reset?.();
});
afterEach(() => {
  Object.assign(_catalogPricingDeps, originalCatalogDeps);
  Object.assign(_acpAdapterDeps, originalAcpDeps);
  _catalogPricingDeps.reset?.();
  mock.restore();
});

describe("acp-catalog-pricing", () => {
  test("AC-1: default catalog returns finite positive Claude Sonnet 5 rates", async () => {
    const rates = await lookupPricing("anthropic", "claude-sonnet-5");
    expect(rates).toBeDefined(); expect(Number.isFinite(rates?.inputPer1M)).toBe(true); expect(rates?.inputPer1M).toBeGreaterThan(0); expect(Number.isFinite(rates?.outputPer1M)).toBe(true); expect(rates?.outputPer1M).toBeGreaterThan(0);
  });
  test("AC-2: unknown provider and model returns undefined without throwing", async () => { await expect(lookupPricing("no-such-provider", "no-such-model")).resolves.toBeUndefined(); });
  test("AC-3: catalog cache prices map exactly to TokenPricing", async () => {
    _catalogPricingDeps.defaultProviders = async () => ({ model: () => ({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }) });
    const r = await lookupPricing("p", "m"); expect(r?.inputPer1M).toBe(3); expect(r?.outputPer1M).toBe(15); expect(r?.cacheReadPer1M).toBe(0.3); expect(r?.cacheCreationPer1M).toBe(3.75);
  });
  test("AC-4: catalog pricing tiers are retained", async () => {
    _catalogPricingDeps.defaultProviders = async () => ({ model: () => ({ input: 1, output: 2, tiers: [{ input: 2, output: 4, inputTokensAbove: 200000 }] }) });
    const r = await lookupPricing("p", "m"); expect(r?.tiers).toBeDefined(); expect(r?.tiers).toHaveLength(1); expect(r?.tiers?.[0]?.inputTokensAbove).toBe(200000);
  });
  test("AC-5: default provider catalogue is loaded once across successive lookups", async () => {
    const loader = mock(async () => ({ model: () => ({ input: 1, output: 2 }) })); _catalogPricingDeps.defaultProviders = loader;
    await lookupPricing("anthropic", "claude-sonnet-5"); await lookupPricing("anthropic", "claude-sonnet-5"); expect(loader).toHaveBeenCalledTimes(1);
  });
  test("AC-6: rejected catalogue loading resolves lookup as undefined", async () => { _catalogPricingDeps.defaultProviders = mock(async () => Promise.reject(new Error("load failed"))); await expect(lookupPricing("anthropic", "claude-sonnet-5")).resolves.toBeUndefined(); });
  test("AC-7: bundled sonnet alias resolves to a catalog rate card", async () => { expect((await resolveRateCard("sonnet")).source).toBe("catalog-rates"); });
  test("AC-8: provider-qualified model bypasses alias loading", async () => {
    const loadAliases = mock(() => { throw new Error("qualified ids must not load aliases"); }); _catalogPricingDeps.loadAliases = loadAliases; _catalogPricingDeps.lookupPricing = async () => positiveCard.rates;
    expect((await resolveRateCard("minimax/MiniMax-M2.7")).source).toBe("catalog-rates"); expect(loadAliases).toHaveBeenCalledTimes(0);
  });
  test("AC-9: qualified ids split only at the first slash", async () => { const lookup = mock(async () => positiveCard.rates); _catalogPricingDeps.lookupPricing = lookup; await resolveRateCard("huggingface/MiniMaxAI/MiniMax-M2.7"); expect(lookup).toHaveBeenCalledWith("huggingface", "MiniMaxAI/MiniMax-M2.7"); });
  test("AC-10: effort suffix is stripped before catalog lookup", async () => { const lookup = mock(async () => positiveCard.rates); _catalogPricingDeps.lookupPricing = lookup; await resolveRateCard("gpt-5.6-luna[high]"); expect(lookup.mock.calls[0]?.[1]).toBe("gpt-5.6-luna"); expect(lookup.mock.calls[0]?.[1]).not.toContain("["); });
  test("AC-11: unresolved ids use positive finite fallback rates", async () => { _catalogPricingDeps.lookupPricing = async () => undefined; const card = await resolveRateCard("no-such-model-anywhere"); expect(card.source).toBe("fallback-rates"); expect(Number.isFinite(card.rates.inputPer1M) && card.rates.inputPer1M > 0).toBe(true); expect(Number.isFinite(card.rates.outputPer1M) && card.rates.outputPer1M > 0).toBe(true); });
  test("AC-12: an unresolved id warns only once when resolved twice", async () => { const warn = mock(() => {}); _catalogPricingDeps.lookupPricing = async () => undefined; _catalogPricingDeps.warn = warn; await resolveRateCard("no-such-model-anywhere"); await resolveRateCard("no-such-model-anywhere"); expect(warn).toHaveBeenCalledTimes(1); expect(String(warn.mock.calls[0])).toContain("no-such-model-anywhere"); });
  test("AC-13: each distinct unresolved id warns once", async () => { const warn = mock(() => {}); _catalogPricingDeps.lookupPricing = async () => undefined; _catalogPricingDeps.warn = warn; await resolveRateCard("no-such-model-anywhere"); await resolveRateCard("also-not-a-model"); expect(warn).toHaveBeenCalledTimes(2); expect(String(warn.mock.calls)).toContain("no-such-model-anywhere"); expect(String(warn.mock.calls)).toContain("also-not-a-model"); });
  test("AC-14: sonnet alias looks up anthropic claude-sonnet-5", async () => { const lookup = mock(async () => positiveCard.rates); _catalogPricingDeps.lookupPricing = lookup; await resolveRateCard("sonnet"); expect(lookup).toHaveBeenCalledTimes(1); expect(lookup).toHaveBeenCalledWith("anthropic", "claude-sonnet-5"); });
  test("AC-15: every bundled alias points at a catalog model", async () => { const missing: string[] = []; for (const [id, target] of Object.entries(aliases as Record<string, { provider: string; model: string }>)) if ((await lookupPricing(target.provider, target.model)) === undefined) missing.push(id); expect(missing, `aliases missing catalog pricing: ${missing.join(", ")}`).toEqual([]); });
  test("AC-16: estimateCostUsd prices one million input and output tokens", () => { expect(Math.abs(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, { inputPer1M: 2, outputPer1M: 10 }) - 12)).toBeLessThan(1e-9); });
  test("AC-17: cache reads fall back to input price", () => { expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }, { inputPer1M: 2, outputPer1M: 10 })).toBe(2); });
  test("AC-18: input usage above a tier threshold uses the tier rate", () => { expect(estimateCostUsd({ inputTokens: 250000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { inputPer1M: 10, outputPer1M: 10, tiers: [{ inputTokensAbove: 200000, inputPer1M: 2, outputPer1M: 10 }] })).toBe(0.5); });
  test("AC-19: input usage at or below a tier threshold uses the base rate", () => { expect(estimateCostUsd({ inputTokens: 100000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { inputPer1M: 10, outputPer1M: 10, tiers: [{ inputTokensAbove: 200000, inputPer1M: 2, outputPer1M: 10 }] })).toBe(1); });
  test("AC-20: alias whose target is absent falls back and warns", async () => { const warn = mock(() => {}); _catalogPricingDeps.loadAliases = () => ({ sonnet: { provider: "missing", model: "missing" } }); _catalogPricingDeps.lookupPricing = async () => undefined; _catalogPricingDeps.warn = warn; const card = await resolveRateCard("sonnet"); expect(card.source).toBe("fallback-rates"); expect(card.rates.inputPer1M).toBeGreaterThan(0); expect(card.rates.outputPer1M).toBeGreaterThan(0); expect(warn).toHaveBeenCalledTimes(1); expect(String(warn.mock.calls[0])).toContain("sonnet"); });
  test("AC-21: catalog load failure remains available through fallback and warns once", async () => { const warn = mock(() => {}); _catalogPricingDeps.defaultProviders = async () => Promise.reject(new Error("load failed")); _catalogPricingDeps.warn = warn; const cards = await Promise.all([resolveRateCard("a"), resolveRateCard("b"), resolveRateCard("c")]); for (const card of cards) { expect(card.source).toBe("fallback-rates"); expect(card.rates.inputPer1M).toBeGreaterThan(0); expect(card.rates.outputPer1M).toBeGreaterThan(0); } expect(warn).toHaveBeenCalledTimes(1); });
  test("AC-22: complete propagates catalog pricingSource", async () => { _acpAdapterDeps.createClient = mock(() => clientWith(successfulSession())); _acpAdapterDeps.resolveRateCard = mock(async () => positiveCard); await expect(new AcpAgentAdapter("claude").complete("prompt", completeOptions())).resolves.toMatchObject({ pricingSource: "catalog-rates" }); });
  test("AC-23: session sendTurn propagates catalog pricingSource", async () => { _acpAdapterDeps.createClient = mock(() => clientWith(successfulSession())); _acpAdapterDeps.resolveRateCard = mock(async () => positiveCard); const adapter = new AcpAgentAdapter("claude"); const handle = await adapter.openSession("pricing-source", openOptions()); await expect(adapter.sendTurn(handle, "prompt", { interactionHandler: { onInteraction: async () => null } } as any)).resolves.toMatchObject({ pricingSource: "catalog-rates" }); });
  test("AC-24: complete propagates fallback pricingSource", async () => { _acpAdapterDeps.createClient = mock(() => clientWith(successfulSession())); _acpAdapterDeps.resolveRateCard = mock(async () => ({ ...positiveCard, source: "fallback-rates" })); await expect(new AcpAgentAdapter("claude").complete("prompt", completeOptions())).resolves.toMatchObject({ pricingSource: "fallback-rates" }); });
  test("AC-25: a session resolves its rate card once across two turns", async () => { const resolve = mock(async () => positiveCard); _acpAdapterDeps.createClient = mock(() => clientWith(successfulSession())); _acpAdapterDeps.resolveRateCard = resolve; const adapter = new AcpAgentAdapter("claude"); const handle = await adapter.openSession("one-rate-card", openOptions()); await adapter.sendTurn(handle, "one", { interactionHandler: { onInteraction: async () => null } } as any); await adapter.sendTurn(handle, "two", { interactionHandler: { onInteraction: async () => null } } as any); expect(resolve).toHaveBeenCalledTimes(1); });
  test("AC-26: buildTurnResult estimates rate-card cost", () => { const result = buildTurnResult({ lastResponse: null, totalTokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, totalExactCostUsd: undefined, turnCount: 1, interactions: [], timedOut: false, rateCard: positiveCard }); expect(result.estimatedCostUsd).toBe(12); });
  test("AC-27: buildTurnResult preserves wire exact cost", () => { const result = buildTurnResult({ lastResponse: null, totalTokenUsage: { inputTokens: 0, outputTokens: 0 }, totalExactCostUsd: 0.42, turnCount: 0, interactions: [], timedOut: false, rateCard: positiveCard }); expect(result.exactCostUsd).toBe(0.42); });
  test("AC-28: wire exact cost wins over catalog pricing source in cost rows", () => { let dispatch: ((event: any) => void) | undefined; const rows: any[] = []; const off = attachCostSubscriber({ onDispatch: (fn: any) => ((dispatch = fn), () => {}), onDispatchError: () => () => {}, onOperationCompleted: () => () => {} } as any, { record: (row: any) => rows.push(row), recordError: () => {}, recordOperationSummary: () => {} } as any, "run"); dispatch?.({ kind: "complete", timestamp: Date.now(), agentName: "native", model: "anthropic/claude-sonnet-5", stage: "complete", sessionRole: "main", storyId: "US-1", callId: "c", scopeId: "s", tokenUsage: { inputTokens: 1, outputTokens: 1 }, estimatedCostUsd: 99, exactCostUsd: 0.42, pricingSource: "catalog-rates", durationMs: 1 }); expect(rows[0]?.pricingSource).toBe("wire"); off(); });
  test("AC-29: timed-out turn results preserve empty output", () => { const result = buildTurnResult({ lastResponse: { messages: [{ role: "assistant", content: "partial" }] }, totalTokenUsage: { inputTokens: 0, outputTokens: 0 }, totalExactCostUsd: undefined, turnCount: 1, interactions: [], timedOut: true, rateCard: positiveCard }); expect(result.output).toBe(""); });
  test("AC-30: undefined resolves to unknown-model", () => { expect(resolvePricingSource(undefined)).toBe("unknown-model"); });
  test("AC-30: empty string resolves to unknown-model", () => { expect(resolvePricingSource("")).toBe("unknown-model"); });
  test("AC-30: unknown resolves to unknown-model", () => { expect(resolvePricingSource("unknown")).toBe("unknown-model"); });
  test("AC-31: all non-empty resolved models use fallback-rates and calculate has no MODEL_PRICING", async () => { expect(resolvePricingSource("claude-sonnet-5")).toBe("fallback-rates"); expect(resolvePricingSource("arbitrary-model")).toBe("fallback-rates"); const source = await readFile(join(import.meta.dir, "../../../src/agents/cost/calculate.ts"), "utf8"); expect(source).not.toContain("MODEL_PRICING"); });
});