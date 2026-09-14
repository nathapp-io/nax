/**
 * US-002 — ACP adapter stamps the effective `priceCall`-resolved rates on
 * `CompleteResult.rates` (complete path, AC2 / AC5 / AC7) and on
 * `TurnResult.rates` (sendTurn path, AC3 / AC8).
 *
 * Acceptance criteria covered:
 *   AC2 — ACP `complete()` for a priced call: `CompleteResult.rates` has
 *          four fields equal to the effective rates used to price the call.
 *   AC3 — ACP `sendTurn()` for a priced turn: `TurnResult.rates` has four
 *          fields equal to the effective rates used to price the turn.
 *   AC5 — ACP `complete()` with a tiered rate card and nonzero usage
 *          crossing the tier threshold: returned `CompleteResult.rates`
 *          equals the winning tier's rates, not the card's base rates.
 *   AC7 — ACP `complete()` for zero input AND zero output tokens: returned
 *          `CompleteResult` has NO `rates` field because the nonzero-usage
 *          guard skipped pricing entirely.
 *   AC8 — ACP `sendTurn()` for zero accumulated token usage: returned
 *          `TurnResult` has NO `rates` field for the same reason.
 *
 * The tests drive the real `AcpAgentAdapter` paths through a stub client
 * that returns a configurable response, with `_acpAdapterDeps.resolveRateCard`
 * stubbed to a per-test card. The implementer must declare
 * `CompleteResult.rates?: ResolvedRates` and `TurnResult.rates?: ResolvedRates`,
 * run `priceCall` through the resolved rate card, and stamp the resulting
 * `ResolvedRates` onto the returned result — omitting the field whenever the
 * nonzero-usage guard skipped pricing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _acpAdapterDeps, AcpAgentAdapter } from "@/agents/acp/adapter";
import type { RateCard } from "@/agents/cost";
import { NO_OP_INTERACTION_HANDLER } from "@/agents/interaction-handler";
import type { OpenSessionOpts } from "@/agents/session-types";
import { resolvePermissions } from "@/config/permissions";
import type { AcpSessionResponse } from "./adapter.test";
import { makeClient, makeSession } from "./adapter.test";

const ACP_WORKDIR = "/tmp/nax-us-002-rates";

const TEST_PERMS = resolvePermissions(undefined, "complete");

function makeOpenSessionOpts(overrides: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: ACP_WORKDIR,
    resolvedPermissions: TEST_PERMS,
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

function makeCompleteOptions(overrides: Record<string, unknown> = {}) {
  return {
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    workdir: ACP_WORKDIR,
    resolvedPermissions: TEST_PERMS,
    ...overrides,
  };
}

function successResponse(overrides: Partial<AcpSessionResponse> = {}): AcpSessionResponse {
  return {
    messages: [{ role: "assistant", content: "done." }],
    stopReason: "end_turn",
    cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

/** Build a stub `_acpAdapterDeps.resolveRateCard` that returns the requested
 *  card and records its calls. The `calls` array is consulted by tests that
 *  want to verify what was resolved. */
function stubResolveRateCard(card: RateCard) {
  const calls: string[] = [];
  const fn = Object.assign(async (_modelId: string): Promise<RateCard> => card, { calls });
  return { fn, calls };
}

describe("AcpAgentAdapter.complete() — CompleteResult.rates propagation (US-002)", () => {
  let origCreateClient: typeof _acpAdapterDeps.createClient;
  let origSleep: typeof _acpAdapterDeps.sleep;
  let origResolveRateCard: typeof _acpAdapterDeps.resolveRateCard;

  beforeEach(() => {
    origCreateClient = _acpAdapterDeps.createClient;
    origSleep = _acpAdapterDeps.sleep;
    origResolveRateCard = _acpAdapterDeps.resolveRateCard;
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    _acpAdapterDeps.resolveRateCard = origResolveRateCard;
    mock.restore();
  });

  // AC2 (success): a priced call returns the four-field ResolvedRates
  // whose values equal the effective rates that priced it.
  test("AC2: complete() returns rates.inputPer1M and rates.outputPer1M equal to the catalog rates", async () => {
    const card: RateCard = {
      rates: { inputPer1M: 2, outputPer1M: 10 },
      source: "catalog-rates",
    };
    const stub = stubResolveRateCard(card);
    _acpAdapterDeps.resolveRateCard = mock(stub.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("hi", makeCompleteOptions());

    expect(result.rates).toBeDefined();
    expect(result.rates?.inputPer1M).toBe(2);
    expect(result.rates?.outputPer1M).toBe(10);
  });

  // AC2 boundary: the cache legs are included too (substituted with
  // inputPer1M when the card does not declare them). Pinning the field
  // count keeps an implementer from dropping one of the four fields.
  test("AC2 boundary: rates carries cacheReadPer1M and cacheCreationPer1M (substituted with inputPer1M when undefined)", async () => {
    const card: RateCard = {
      rates: { inputPer1M: 3, outputPer1M: 15 },
      source: "catalog-rates",
    };
    const stub = stubResolveRateCard(card);
    _acpAdapterDeps.resolveRateCard = mock(stub.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("hi", makeCompleteOptions());

    expect(result.rates?.cacheReadPer1M).toBe(3);
    expect(result.rates?.cacheCreationPer1M).toBe(3);
    expect(Object.keys(result.rates ?? {}).sort()).toEqual([
      "cacheCreationPer1M",
      "cacheReadPer1M",
      "inputPer1M",
      "outputPer1M",
    ]);
  });

  // AC5 (success): with a tiered card and nonzero usage crossing the
  // threshold, the returned `rates` equals the winning tier's rates
  // and not the card's base rates.
  test("AC5: complete() with a tiered card and nonzero usage crossing the threshold returns the winning tier's rates", async () => {
    const card: RateCard = {
      rates: {
        inputPer1M: 1,
        outputPer1M: 5,
        tiers: [{ inputPer1M: 4, outputPer1M: 20, inputTokensAbove: 100_000 }],
      },
      source: "catalog-rates",
    };
    const stub = stubResolveRateCard(card);
    _acpAdapterDeps.resolveRateCard = mock(stub.fn);

    // 200_000 input tokens strictly exceeds 100_000 — the tier wins.
    const session = makeSession({
      promptFn: async () =>
        successResponse({
          cumulative_token_usage: { input_tokens: 200_000, output_tokens: 0 },
        }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("hi", makeCompleteOptions());

    expect(result.rates?.inputPer1M).toBe(4);
    expect(result.rates?.outputPer1M).toBe(20);
  });

  // AC7 (failure / boundary): the nonzero-usage guard skips pricing entirely
  // when both classes are zero. `rates` is therefore ABSENT — not undefined,
  // not a zeroed-out object. The expected failure: the field is not present
  // on the result object.
  test("AC7: complete() with zero input and zero output tokens omits the rates field (nonzero-usage guard skips pricing)", async () => {
    const card: RateCard = {
      rates: { inputPer1M: 2, outputPer1M: 10 },
      source: "catalog-rates",
    };
    const stub = stubResolveRateCard(card);
    _acpAdapterDeps.resolveRateCard = mock(stub.fn);

    // Both classes are zero — the guard's nonzero check fails.
    const session = makeSession({
      promptFn: async () =>
        successResponse({
          cumulative_token_usage: { input_tokens: 0, output_tokens: 0 },
        }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("hi", makeCompleteOptions());

    // Exact invariant the AC names: no `rates` property on the result.
    expect("rates" in result).toBe(false);
  });

  // AC7 boundary: when `cumulative_token_usage` reports values that round to
  // zero but ARE present, the guard let pricing through — `rates` IS defined.
  // Pins that the boundary is "both classes are zero", not
  // "cumulative_token_usage is undefined".
  test("AC7 boundary: zero input AND zero output tokens present in cumulative_token_usage still omits rates", async () => {
    const card: RateCard = {
      rates: { inputPer1M: 2, outputPer1M: 10 },
      source: "catalog-rates",
    };
    const stub = stubResolveRateCard(card);
    _acpAdapterDeps.resolveRateCard = mock(stub.fn);

    const session = makeSession({
      promptFn: async () =>
        successResponse({
          cumulative_token_usage: { input_tokens: 0, output_tokens: 0 },
        }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("hi", makeCompleteOptions());

    expect("rates" in result).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendTurn() — TurnResult.rates propagation (US-002 AC3, AC8)
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter.sendTurn() — TurnResult.rates propagation (US-002)", () => {
  let origCreateClient: typeof _acpAdapterDeps.createClient;
  let origSleep: typeof _acpAdapterDeps.sleep;
  let origResolveRateCard: typeof _acpAdapterDeps.resolveRateCard;

  beforeEach(() => {
    origCreateClient = _acpAdapterDeps.createClient;
    origSleep = _acpAdapterDeps.sleep;
    origResolveRateCard = _acpAdapterDeps.resolveRateCard;
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    _acpAdapterDeps.resolveRateCard = origResolveRateCard;
    mock.restore();
  });

  // AC3 (success): a priced turn (nonzero totalTokenUsage) returns the
  // four-field ResolvedRates whose values equal the effective rates that
  // priced the turn.
  test("AC3: sendTurn() returns rates.inputPer1M and rates.outputPer1M equal to the catalog rates for a priced turn", async () => {
    const card: RateCard = {
      rates: { inputPer1M: 2, outputPer1M: 10 },
      source: "catalog-rates",
    };
    const stub = stubResolveRateCard(card);
    _acpAdapterDeps.resolveRateCard = mock(stub.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const handle = await adapter.openSession("nax-us-002-turn", makeOpenSessionOpts());
    const result = await adapter.sendTurn(handle, "do the thing", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    expect(result.rates).toBeDefined();
    expect(result.rates?.inputPer1M).toBe(2);
    expect(result.rates?.outputPer1M).toBe(10);
  });

  // AC3 boundary: cache legs are included (substituted with inputPer1M).
  test("AC3 boundary: rates carries cacheReadPer1M and cacheCreationPer1M (substituted when undefined)", async () => {
    const card: RateCard = {
      rates: { inputPer1M: 3, outputPer1M: 15 },
      source: "catalog-rates",
    };
    const stub = stubResolveRateCard(card);
    _acpAdapterDeps.resolveRateCard = mock(stub.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const handle = await adapter.openSession("nax-us-002-turn-cache", makeOpenSessionOpts());
    const result = await adapter.sendTurn(handle, "do the thing", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    expect(result.rates?.cacheReadPer1M).toBe(3);
    expect(result.rates?.cacheCreationPer1M).toBe(3);
    expect(Object.keys(result.rates ?? {}).sort()).toEqual([
      "cacheCreationPer1M",
      "cacheReadPer1M",
      "inputPer1M",
      "outputPer1M",
    ]);
  });

  // AC5 sendTurn path: with a tiered card and nonzero usage crossing the
  // threshold, the TurnResult's `rates` equals the winning tier's rates.
  test("AC5: sendTurn() with a tiered card and nonzero usage crossing the threshold returns the winning tier's rates", async () => {
    const card: RateCard = {
      rates: {
        inputPer1M: 1,
        outputPer1M: 5,
        tiers: [{ inputPer1M: 4, outputPer1M: 20, inputTokensAbove: 100_000 }],
      },
      source: "catalog-rates",
    };
    const stub = stubResolveRateCard(card);
    _acpAdapterDeps.resolveRateCard = mock(stub.fn);

    const session = makeSession({
      promptFn: async () =>
        successResponse({
          cumulative_token_usage: { input_tokens: 200_000, output_tokens: 0 },
        }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const handle = await adapter.openSession("nax-us-002-turn-tier", makeOpenSessionOpts());
    const result = await adapter.sendTurn(handle, "do the thing", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    expect(result.rates?.inputPer1M).toBe(4);
    expect(result.rates?.outputPer1M).toBe(20);
  });

  // AC8 (failure / boundary): when accumulated tokens are zero, the
  // nonzero-usage guard skips pricing entirely. `rates` is absent.
  test("AC8: sendTurn() with zero accumulated token usage omits the rates field", async () => {
    const card: RateCard = {
      rates: { inputPer1M: 2, outputPer1M: 10 },
      source: "catalog-rates",
    };
    const stub = stubResolveRateCard(card);
    _acpAdapterDeps.resolveRateCard = mock(stub.fn);

    // Wire response carries zero tokens — the accumulator stays at zero.
    const session = makeSession({
      promptFn: async () =>
        successResponse({
          cumulative_token_usage: { input_tokens: 0, output_tokens: 0 },
        }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const handle = await adapter.openSession("nax-us-002-turn-zero", makeOpenSessionOpts());
    const result = await adapter.sendTurn(handle, "do the thing", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
    });

    // Exact invariant the AC names: no `rates` property on the result.
    expect("rates" in result).toBe(false);
  });
});
