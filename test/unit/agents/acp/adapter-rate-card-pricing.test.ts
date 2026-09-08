/**
 * US-002 — ACP adapter wires `pricingSource` from a resolved rate card.
 *
 * AC1: complete() with a stubbed resolveRateCard returning a "catalog-rates"
 *      card stamps `pricingSource: "catalog-rates"` on CompleteResult.
 * AC2: sendTurn() on a session opened by openSession() with a stubbed
 *      resolveRateCard returning a "catalog-rates" card stamps
 *      `pricingSource: "catalog-rates"` on TurnResult.
 * AC3: complete() for a "fallback-rates" card stamps
 *      `pricingSource: "fallback-rates"` on CompleteResult.
 * AC4: sendTurn() invoked twice on the same session invokes resolveRateCard
 *      exactly once.
 * AC7: complete() with a response carrying `exactCostUsd` records a cost
 *      row whose `pricingSource: "wire"` takes precedence over the card's
 *      source ("catalog-rates"). The dispatch event still carries the
 *      card's source — the precedence lives in the cost middleware.
 *
 * Test seam: `_acpAdapterDeps.resolveRateCard` is the stubbed seam the
 * adapter consults. The implementer must wire the seam into both
 * `complete()` and `openSession()`; this file replaces the default with a
 * mock that records its calls and returns a card built from a per-test
 * argument.
 *
 * AC7 exercises the full dispatch path (adapter → buildCompleteEvent /
 * buildSessionTurnEvent → attachCostSubscriber), so the recorded row's
 * `pricingSource` reflects the middleware's "wire wins" precedence, not
 * the producer's `pricingSource` value.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _acpAdapterDeps, AcpAgentAdapter } from "@/agents/acp/adapter";
import type { RateCard } from "@/agents/cost";
import { NO_OP_INTERACTION_HANDLER } from "@/agents/interaction-handler";
import { buildCompleteEvent, buildSessionTurnEvent } from "@/agents/manager-dispatch";
import type { OpenSessionOpts } from "@/agents/session-types";
import { resolvePermissions } from "@/config/permissions";
import { type CostEvent, createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachCostSubscriber } from "@/runtime/middleware/cost";
import type { AcpSessionResponse } from "./adapter.test";
import { makeClient, makeSession } from "./adapter.test";

const ACP_WORKDIR = "/tmp/nax-rate-card-pricing";

const CATALOG_CARD: RateCard = {
  rates: { inputPer1M: 2, outputPer1M: 10 },
  source: "catalog-rates",
};

const FALLBACK_CARD: RateCard = {
  rates: { inputPer1M: 3, outputPer1M: 15 },
  source: "fallback-rates",
};

const TEST_PERMS = resolvePermissions(undefined, "complete");

function makeOpenSessionOpts(overrides: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: ACP_WORKDIR,
    resolvedPermissions: { mode: "approve-reads" },
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

function makeCompleteOptions(
  overrides: Record<string, unknown> = {},
): import("@/agents/types").ResolvedCompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    workdir: ACP_WORKDIR,
    resolvedPermissions: { mode: "approve-reads" as const },
    ...overrides,
  } as import("@/agents/types").ResolvedCompleteOptions;
}

/** Default AcpSessionResponse carrying the token-usage the adapter uses to bill. */
function successResponse(overrides: Partial<AcpSessionResponse> = {}): AcpSessionResponse {
  return {
    messages: [{ role: "assistant", content: "done." }],
    stopReason: "end_turn",
    cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

/**
 * Build a mock `_acpAdapterDeps.resolveRateCard` that returns `card` and
 * records its calls. The `calls` array carries the modelId strings the
 * adapter actually consults, so AC4 can pin that sendTurn does not
 * re-resolve across calls.
 */
function stubResolveRateCard(card: RateCard): {
  fn: (modelId: string) => Promise<RateCard>;
  calls: string[];
} {
  const calls: string[] = [];
  const fn = Object.assign(
    async (modelId: string): Promise<RateCard> => {
      calls.push(modelId);
      return card;
    },
    { calls },
  );
  return { fn, calls };
}

describe("complete() — pricingSource from resolveRateCard", () => {
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

  // AC1 (success): a catalog-rates card flows through complete() onto
  // CompleteResult.pricingSource. Stub returns `undefined` until the
  // implementer wires the seam in.
  test("AC1: complete() with resolveRateCard returning catalog-rates stamps pricingSource=catalog-rates on CompleteResult", async () => {
    const card = stubResolveRateCard(CATALOG_CARD);
    _acpAdapterDeps.resolveRateCard = mock(card.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("hi", makeCompleteOptions());
    expect(result.pricingSource).toBe("catalog-rates");
  });

  // AC1 boundary: the seam is consulted for the resolved model's id —
  // i.e. the adapter passes modelDef.model (not the agent name) to
  // resolveRateCard. Pins that the seam is reached on the right argument.
  test("AC1 boundary: resolveRateCard is invoked with modelDef.model", async () => {
    const card = stubResolveRateCard(CATALOG_CARD);
    _acpAdapterDeps.resolveRateCard = mock(card.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    await new AcpAgentAdapter("claude").complete(
      "hi",
      makeCompleteOptions({
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5", env: {} },
      }),
    );
    expect(card.calls).toEqual(["claude-haiku-4-5"]);
  });

  // AC3 (success): a fallback-rates card flows through. The two
  // branches (catalog-rates / fallback-rates) must both reach the
  // result — this is the assertion that the seam actually reads
  // `rateCard.source` rather than hardcoding "catalog-rates".
  test("AC3: complete() with resolveRateCard returning fallback-rates stamps pricingSource=fallback-rates on CompleteResult", async () => {
    const card = stubResolveRateCard(FALLBACK_CARD);
    _acpAdapterDeps.resolveRateCard = mock(card.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("hi", makeCompleteOptions());
    expect(result.pricingSource).toBe("fallback-rates");
  });

  // AC7 (success, complete path): when a dispatch carries
  // wire-reported exactCostUsd, the recorded cost row stamps
  // pricingSource="wire" — the wire precedence AC7 names — even
  // though the producer's pricingSource is the card's "catalog-rates".
  // The dispatch event still carries the card's source (audit reads
  // it); the cost middleware rewrites to "wire" at the row level.
  test("AC7: complete() with wire-reported exactCostUsd records a cost row with pricingSource=wire (precedence over catalog-rates)", async () => {
    const card = stubResolveRateCard(CATALOG_CARD);
    _acpAdapterDeps.resolveRateCard = mock(card.fn);

    const session = makeSession({
      promptFn: async () => successResponse({ exactCostUsd: 0.012 }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const options = makeCompleteOptions({ sessionName: "nax-ac7-complete" });
    const startedAt = 1_000;
    const result = await adapter.complete("hi", options);

    // Producer-side: the adapter does NOT strip pricingSource when
    // exactCostUsd is reported — it still carries the card's source.
    expect(result.exactCostUsd).toBe(0.012);
    expect(result.pricingSource).toBe("catalog-rates");

    // Build the dispatch event the manager would emit and feed it
    // through the cost subscriber. The recorded row's pricingSource
    // reflects the middleware's "wire wins" precedence, not the
    // producer's report.
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "test-run");

    bus.emitDispatch(
      buildCompleteEvent({
        sessionName: options.sessionName ?? "nax-ac7-complete",
        prompt: "hi",
        response: result.output,
        agentName: adapter.name,
        stage: "complete",
        options,
        resolvedPermissions: TEST_PERMS,
        tokenUsage: result.tokenUsage,
        estimatedCostUsd: result.estimatedCostUsd,
        exactCostUsd: result.exactCostUsd,
        startedAt,
        pricingSource: result.pricingSource,
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].pricingSource).toBe("wire");
    expect(recorded[0].exactCostUsd).toBe(0.012);
    expect(recorded[0].confidence).toBe("exact");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// openSession() + sendTurn() — pricingSource from resolveRateCard
// ─────────────────────────────────────────────────────────────────────────────

describe("openSession() + sendTurn() — pricingSource from resolveRateCard", () => {
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

  // AC2 (success): a session opened under a catalog-rates card emits a
  // TurnResult with the same source. The session handle carries the
  // resolved card so subsequent sendTurn calls reuse it without
  // re-resolving (AC4).
  test("AC2: sendTurn() on a session opened with resolveRateCard returning catalog-rates stamps pricingSource=catalog-rates on TurnResult", async () => {
    const card = stubResolveRateCard(CATALOG_CARD);
    _acpAdapterDeps.resolveRateCard = mock(card.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const handle = await adapter.openSession("nax-rate-card", makeOpenSessionOpts());
    const result = await adapter.sendTurn(handle, "do the thing", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    expect(result.pricingSource).toBe("catalog-rates");
  });

  // AC4 (success): two sendTurn() calls on one session invoke
  // resolveRateCard exactly once. The card is resolved at openSession
  // and held on the session handle, mirroring the native path's
  // "resolve once, reuse per turn" pattern (US-002 approach §1).
  test("AC4: sendTurn() called twice on one session invokes resolveRateCard exactly once", async () => {
    const card = stubResolveRateCard(CATALOG_CARD);
    _acpAdapterDeps.resolveRateCard = mock(card.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const handle = await adapter.openSession("nax-rate-card-once", makeOpenSessionOpts());
    await adapter.sendTurn(handle, "first prompt", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    await adapter.sendTurn(handle, "second prompt", { interactionHandler: NO_OP_INTERACTION_HANDLER });

    expect(card.calls.length).toBe(1);
  });

  // AC4 boundary: the one call is the one openSession() makes — not the
  // two sendTurn() calls. Pins the resolution site, not just the count.
  test("AC4 boundary: the single resolveRateCard call originates from openSession(), not sendTurn()", async () => {
    const card = stubResolveRateCard(CATALOG_CARD);
    _acpAdapterDeps.resolveRateCard = mock(card.fn);

    const session = makeSession({ promptFn: async () => successResponse() });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    await adapter.openSession("nax-rate-card-site", makeOpenSessionOpts());
    expect(card.calls.length).toBe(1);

    const handle = await adapter.openSession("nax-rate-card-site-2", makeOpenSessionOpts());
    expect(card.calls.length).toBe(2);

    await adapter.sendTurn(handle, "turn 1", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    await adapter.sendTurn(handle, "turn 2", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    expect(card.calls.length).toBe(2);
  });

  // AC7 (success, sendTurn path): the same wire-precedence rule
  // applies on the session-turn path — the producer still reports
  // the card's source, but the cost subscriber stamps "wire" because
  // exactCostUsd wins.
  test("AC7: sendTurn() with wire-reported exactCostUsd records a cost row with pricingSource=wire (precedence over catalog-rates)", async () => {
    const card = stubResolveRateCard(CATALOG_CARD);
    _acpAdapterDeps.resolveRateCard = mock(card.fn);

    const session = makeSession({
      promptFn: async () => successResponse({ exactCostUsd: 0.012 }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const sessionName = "nax-ac7-sendturn";
    const handle = await adapter.openSession(sessionName, makeOpenSessionOpts());
    const startedAt = 1_000;
    const result = await adapter.sendTurn(handle, "do the thing", { interactionHandler: NO_OP_INTERACTION_HANDLER });

    // Producer-side: same invariant as the complete path — the
    // adapter does not strip pricingSource when exactCostUsd is set.
    expect(result.exactCostUsd).toBe(0.012);
    expect(result.pricingSource).toBe("catalog-rates");

    // Build the session-turn dispatch event the manager would emit
    // and feed it through the cost subscriber.
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "test-run");

    bus.emitDispatch(
      buildSessionTurnEvent({
        handle,
        sessionRole: "main",
        prompt: "do the thing",
        result,
        agentName: adapter.name,
        stage: "run",
        opts: { pipelineStage: "run", workdir: ACP_WORKDIR },
        resolvedPermissions: TEST_PERMS,
        startedAt,
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].pricingSource).toBe("wire");
    expect(recorded[0].exactCostUsd).toBe(0.012);
    expect(recorded[0].confidence).toBe("exact");
  });
});
