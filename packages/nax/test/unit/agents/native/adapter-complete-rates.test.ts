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
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ClientRequest, Pricing, ResolvedModel } from "@nathapp/nax-ai";
import { makeNaxConfig } from "@test/helpers";
import { _adapterDeps, NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import type { ResolvedCompaction } from "@/agents/native/session/compaction";
import * as sessionState from "@/agents/native/session/session";
import { openNativeSession } from "@/agents/native/session/session";
import * as transcriptStore from "@/agents/native/session/transcript-store";
import { saveTranscript } from "@/agents/native/session/transcript-store";
import type { OpenSessionOpts } from "@/agents/session-types";
import type { ResolvedCompleteOptions } from "@/agents/types";
import { SessionFailureError, SessionTurnError } from "@/agents/types";
import type { ModelDef } from "@/config/schema-types";
import type { AdapterFailure } from "@/context/engine";
import { NaxError } from "@/errors";
import { closeStorySessions } from "@/execution/session-manager-runtime";
import { DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";
import { byCodePoint } from "@/utils/sort";

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
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
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

const turnClassModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

function fakeClient(over: Record<string, unknown> = {}): Client {
  return {
    model: async () => turnClassModel,
    listModels: async () => [turnClassModel],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async () => ({
      text: "ok",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      stopReason: "stop",
    }),
    validate: () => {},
    ...over,
  };
}

describe("NativeAgentAdapter.sendTurn failure classification", () => {
  class ProtocolStreamError extends Error {
    constructor(readonly protocolError: { kind: string; message: string; retryAfter?: number }) {
      super(protocolError.message);
      this.name = "ProtocolStreamError";
    }
  }

  async function openTurnSession(name: string) {
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession(name, {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), `nax-adapter-${name}-`)),
    });
    return { adapter, handle };
  }

  const send = (adapter: NativeAgentAdapter, handle: Awaited<ReturnType<NativeAgentAdapter["openSession"]>>) =>
    adapter.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

  /** Type-predicate narrowing helper — no cast needed at any call site. */
  function hasAdapterFailure(err: SessionTurnError): err is SessionTurnError & { adapterFailure: AdapterFailure } {
    return err.adapterFailure !== undefined;
  }

  /** Narrows by throwing, so the assertions below need no cast. */
  async function failureFrom(turn: Promise<unknown>): Promise<SessionTurnError & { adapterFailure: AdapterFailure }> {
    const err = await turn.catch((e: unknown) => e);
    if (!(err instanceof SessionTurnError)) {
      throw new Error(`expected a SessionTurnError, got ${err instanceof Error ? err.name : String(err)}`);
    }
    if (!hasAdapterFailure(err)) {
      throw new Error("expected the SessionTurnError to carry adapterFailure");
    }
    return err;
  }

  test("carries a rate limit up as a typed failure, so the backoff written for it can fire", async () => {
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new ProtocolStreamError({ kind: "rate-limit", message: "429 slow down", retryAfter: 30 });
        },
      });
    const { adapter, handle } = await openTurnSession("sess-ratelimit");
    const err = await failureFrom(send(adapter, handle));
    expect(err.adapterFailure.outcome).toBe("fail-rate-limit");
    expect(err.adapterFailure.category).toBe("availability");
    expect(err.adapterFailure.retryAfterSeconds).toBe(30);
  });
  test("keeps the upstream message, which is the only description of what happened", async () => {
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new ProtocolStreamError({ kind: "auth", message: "401 invalid key" });
        },
      });
    const { adapter, handle } = await openTurnSession("sess-auth");
    const err = await failureFrom(send(adapter, handle));
    expect(err.adapterFailure.outcome).toBe("fail-auth");
    expect(err.message).toContain("401 invalid key");
  });
  test("classifies a context overflow as swappable rather than as a crash", async () => {
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        },
      });
    const { adapter, handle } = await openTurnSession("sess-overflow");
    const err = await failureFrom(send(adapter, handle));
    expect(err.adapterFailure.category).toBe("availability");
    expect(err.adapterFailure.message).toContain("context window");
  });
  test("leaves an error that is not a protocol fault exactly as thrown", async () => {
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new TypeError("undefined is not a function");
        },
      });
    const { adapter, handle } = await openTurnSession("sess-bug");
    const err = await send(adapter, handle).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(SessionFailureError);
    expect(err).not.toBeInstanceOf(SessionTurnError);
  });
  // The critical assertion. Two round trips burn real tokens before the
  // third round trip hits a rate limit — the RECORDED cost on the thrown
  // error must be the sum of the first two, not a pre-fix default of 0.
  test("carries the cost burned on earlier round trips into the thrown failure", async () => {
    let calls = 0;
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          calls += 1;
          if (calls <= 2) {
            return {
              text: "still working",
              toolCalls: [{ id: `c${calls}`, name: "query_neighbor", input: {} }],
              usage: { inputTokens: 500_000, outputTokens: 200_000 },
              stopReason: "tool_use" as const,
            };
          }
          throw new ProtocolStreamError({ kind: "rate-limit", message: "429 slow down" });
        },
      });
    const { adapter, handle } = await openTurnSession("sess-cost");
    const err = await failureFrom(send(adapter, handle));
    // MODEL pricing: input $3/1M, output $15/1M. Two round trips of
    // 500k in / 200k out each -> 2 * (1.5 + 3.0) = 9.
    expect(err.tokenUsage?.inputTokens).toBe(1_000_000);
    expect(err.tokenUsage?.outputTokens).toBe(400_000);
    expect(err.estimatedCostUsd).toBeCloseTo(9, 6);
    expect(err.adapterFailure.outcome).toBe("fail-rate-limit");
  });
});

const REAL_WINDOW = 128_000;

function catalogModel(): ResolvedModel {
  return {
    id: "gpt-5.4-mini",
    provider: "openai",
    protocol: "openai-responses",
    pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    contextWindow: REAL_WINDOW,
    supportsTools: true,
    thinkingLevels: [],
  };
}

function countingClient(model: ResolvedModel): { client: Client; completeCalls: () => number } {
  let calls = 0;
  const client: Client = {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async (_m: ResolvedModel, _req: ClientRequest) => {
      calls += 1;
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
    },
    validate: () => {},
  };
  return { client, completeCalls: () => calls };
}

const COMPACTION_CFG: ResolvedCompaction = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

async function openSessionWithModelDef(
  name: string,
  modelDef: ModelDef,
): Promise<{
  adapter: NativeAgentAdapter;
  handle: Awaited<ReturnType<NativeAgentAdapter["openSession"]>>;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), `nax-ctxwin-${name}-`));
  const adapter = new NativeAgentAdapter();
  const handle = await adapter.openSession(name, {
    agentName: "native",
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef,
    timeoutSeconds: 60,
    transcriptDir: dir,
    compaction: COMPACTION_CFG,
  });
  return { adapter, handle, dir };
}

async function seedOversizedTranscript(dir: string, sessionName: string) {
  await saveTranscript(dir, sessionName, [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(20_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(20_000) },
  ]);
}

const sendCtxWin = (adapter: NativeAgentAdapter, handle: Awaited<ReturnType<NativeAgentAdapter["openSession"]>>) =>
  adapter.sendTurn(handle, "next", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

describe("NativeAgentAdapter.sendTurn contextWindow override", () => {
  test("an override below the real window reaches runNativeTurn's deps and fires compaction", async () => {
    const model = catalogModel();
    const { client, completeCalls } = countingClient(model);
    _clientDeps.build = async () => client;
    const { adapter, handle, dir } = await openSessionWithModelDef("ctxwin-below", {
      provider: "unknown",
      model: "openai/gpt-5.4-mini",
      contextWindow: 8_000,
    });
    await seedOversizedTranscript(dir, handle.id);
    await sendCtxWin(adapter, handle);
    // summarize + the real turn: compaction fired only because the override
    // (8,000) reached the turn deps -- the catalog window (128,000) would not
    // have triggered it on this transcript.
    expect(completeCalls()).toBe(2);
  });
  test("no override falls back to the catalog's resolved.contextWindow, so compaction does not fire", async () => {
    const model = catalogModel();
    const { client, completeCalls } = countingClient(model);
    _clientDeps.build = async () => client;
    const { adapter, handle, dir } = await openSessionWithModelDef("ctxwin-fallback", {
      provider: "unknown",
      model: "openai/gpt-5.4-mini",
    });
    await seedOversizedTranscript(dir, handle.id);
    await sendCtxWin(adapter, handle);
    // Same oversized transcript as the "below" case, but no override: the
    // real window (128,000) is nowhere near crossed, so only the turn call
    // happens.
    expect(completeCalls()).toBe(1);
  });
  test("an override above the real window is rejected, naming both numbers", async () => {
    const model = catalogModel();
    const { client } = countingClient(model);
    _clientDeps.build = async () => client;
    const { adapter, handle, dir } = await openSessionWithModelDef("ctxwin-above", {
      provider: "unknown",
      model: "openai/gpt-5.4-mini",
      contextWindow: 200_000,
    });
    await seedOversizedTranscript(dir, handle.id);
    const err = await sendCtxWin(adapter, handle).catch((e: unknown) => e);
    if (!(err instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(err)}`);
    expect(err.message).toContain("200000");
    expect(err.message).toContain(String(REAL_WINDOW));
  });
  test("an override exactly equal to the real window is accepted", async () => {
    const model = catalogModel();
    const { client, completeCalls } = countingClient(model);
    _clientDeps.build = async () => client;
    const { adapter, handle, dir } = await openSessionWithModelDef("ctxwin-equal", {
      provider: "unknown",
      model: "openai/gpt-5.4-mini",
      contextWindow: REAL_WINDOW,
    });
    await seedOversizedTranscript(dir, handle.id);
    await sendCtxWin(adapter, handle);
    // Equal to the real window behaves exactly like no override: the small
    // oversized transcript does not cross it.
    expect(completeCalls()).toBe(1);
  });
});

const costRatesModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

const CATALOG_PRICING = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

function costRatesOptions(): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  };
}

describe("catalog cache rates reach cost through the adapter, not just estimateCostUsd", () => {
  test("complete() prices a cache read at the catalog's cacheRead rate, not the full input rate", async () => {
    _clientDeps.build = async () => ({
      model: async () => costRatesModel,
      listModels: async () => [costRatesModel],
      pricing: () => CATALOG_PRICING,
      stream: async function* stream() {},
      complete: async () => ({
        text: "ok",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
        stopReason: "stop",
      }),
      validate: () => {},
    });
    const result = await new NativeAgentAdapter().complete("hi", costRatesOptions());
    // If the catalog's cacheRead were discarded (the bug), this would fall
    // back to the full input rate: 1M cache-read tokens x $2/1M = $2.00.
    // The catalog's real cacheRead rate is $0.2/1M => $0.20.
    expect(result.estimatedCostUsd).toBeCloseTo(0.2, 6);
  });
  test("complete() prices a cache write at the catalog's cacheWrite rate, not the full input rate", async () => {
    _clientDeps.build = async () => ({
      model: async () => costRatesModel,
      listModels: async () => [costRatesModel],
      pricing: () => CATALOG_PRICING,
      stream: async function* stream() {},
      complete: async () => ({
        text: "ok",
        usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 },
        stopReason: "stop",
      }),
      validate: () => {},
    });
    const result = await new NativeAgentAdapter().complete("hi", costRatesOptions());
    // Discarded cacheWrite would fall back to input ($2/1M => $2.00). The
    // catalog's real cacheWrite rate is $2.5/1M => $2.50 -- the OPPOSITE
    // direction of error from the cache-read case, so a fallback-to-input
    // bug would not show up as "always cheaper" or "always pricier".
    expect(result.estimatedCostUsd).toBeCloseTo(2.5, 6);
  });
  test("sendTurn prices a cache write at the catalog's cacheWrite rate, not the full input rate", async () => {
    _clientDeps.build = async () => ({
      model: async () => costRatesModel,
      listModels: async () => [costRatesModel],
      pricing: () => CATALOG_PRICING,
      stream: async function* stream() {},
      complete: async () => ({
        text: "ok",
        usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 },
        stopReason: "stop",
      }),
      validate: () => {},
    });
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession("sess-cost-rates", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-cost-rates-")),
    });
    const result = await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });
    expect(result.estimatedCostUsd).toBeCloseTo(2.5, 6);
  });
});

const cacheRetentionModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

function cacheRetentionOptions(): ResolvedCompleteOptions {
  return {
    // provider is what resolveModel() infers for this string: "unknown".
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  };
}

function capturingClient(model: ResolvedModel): { client: Client; seen: ClientRequest[] } {
  const seen: ClientRequest[] = [];
  const client: Client = {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async (_m: ResolvedModel, req: ClientRequest) => {
      seen.push(req);
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "stop" };
    },
    validate: () => {},
  };
  return { client, seen };
}

describe("NativeAgentAdapter cacheRetention wiring", () => {
  // Asserted on the request that actually reaches the protocol layer
  // (`seen[n]`), not on a call shape: a mock assertion could pass while the
  // field never made it to the wire.
  test("sendTurn's round-trip call carries cacheRetention: short", async () => {
    const { client, seen } = capturingClient(cacheRetentionModel);
    _clientDeps.build = async () => client;
    const adapter = new NativeAgentAdapter();
    const handle = await adapter.openSession("sess-cache-retention", {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-cache-retention-")),
    });
    await adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });
    expect(seen[0]?.cacheRetention).toBe("short");
  });
  test("complete() (one-shot) never sets cacheRetention", async () => {
    const { client, seen } = capturingClient(cacheRetentionModel);
    _clientDeps.build = async () => client;
    await new NativeAgentAdapter().complete("hi", cacheRetentionOptions());
    expect(seen[0] && "cacheRetention" in seen[0]).toBe(false);
  });
});

describe("cacheRetention through the production SessionManager path", () => {
  test("SessionManager.openSession -> sendPrompt reaches client.complete with cacheRetention: short", async () => {
    const { client, seen } = capturingClient(cacheRetentionModel);
    _clientDeps.build = async () => client;
    const adapter = new NativeAgentAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter });
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-session-manager-cache-retention-"));
    const req: OpenSessionRequest = {
      agentName: "native",
      workdir: process.cwd(),
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
    };
    const handle = await sm.openSession("nax-cache-retention-e2e", req);
    await sm.sendPrompt(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });
    expect(seen[0]?.cacheRetention).toBe("short");
  });
});

// RE-ARCH: keep
let closeDir: string;
beforeEach(async () => {
  closeDir = await mkdtemp(join(tmpdir(), "nax-native-close-"));
});
afterEach(async () => {
  await rm(closeDir, { recursive: true, force: true });
});

function exportedCollections(): string[] {
  return Object.entries(sessionState)
    .filter(([, value]) => value instanceof Map || value instanceof Set)
    .map(([exportName]) => exportName)
    .sort(byCodePoint);
}

function collectionsHolding(name: string): string[] {
  const holding: string[] = [];
  for (const [exportName, value] of Object.entries(sessionState)) {
    if (value instanceof Map && value.has(name)) holding.push(exportName);
    else if (value instanceof Set && value.has(name)) holding.push(exportName);
  }
  return holding.sort(byCodePoint);
}

const openOpts = (over: Partial<OpenSessionOpts> = {}): OpenSessionOpts => ({
  agentName: "native",
  workdir: closeDir,
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
  timeoutSeconds: 60,
  transcriptDir: closeDir,
  transcriptOwner: "call-1",
  compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
  transportRetry: { maxAttempts: 3, baseDelayMs: 2000 },
  spinBreaker: DEFAULT_SPIN_BREAKER_SETTINGS,
  ...over,
});

describe("native closePhysicalSession — run teardown reaches the session maps", () => {
  test("a keepOpen session's story close clears every native map", async () => {
    const adapter = new NativeAgentAdapter();
    const sm = new SessionManager({
      getAdapter: () => adapter,
      config: makeNaxConfig({
        execution: { compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 } },
      }),
    });
    const name = "nax-teardown-us-001-implementer";
    await sm.openSession(name, {
      agentName: "native",
      workdir: closeDir,
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
      timeoutSeconds: 60,
      storyId: "US-001",
      transcriptDir: closeDir,
      transcriptOwner: "call-1",
    });
    // keepOpen: session-run-hop skips closeSession, so the descriptor stays
    // RUNNING and every map keeps its entry. The per-turn entries `open` does
    // not set are added here so the test covers all nine, not only the five the
    // open path happens to populate.
    sessionState.nativeSessionFailed.add(name);
    sessionState.nativeSessionLastUsage.set(name, { promptTokens: 10, anchorIndex: 0 });
    expect(collectionsHolding(name)).toEqual(exportedCollections());
    await closeStorySessions(sm, "US-001", () => adapter);
    expect(sm.getForStory("US-001")).toHaveLength(0);
    expect(collectionsHolding(name)).toEqual([]);
  });
  test("physical close removes a successful session's transcript", async () => {
    const adapter = new NativeAgentAdapter();
    const name = "nax-teardown-us-003-success";
    await openNativeSession(name, openOpts());
    await transcriptStore.saveTranscript(closeDir, name, []);
    expect(await Bun.file(transcriptStore.transcriptPath(closeDir, name)).exists()).toBe(true);
    await adapter.closePhysicalSession(name, closeDir);
    expect(await Bun.file(transcriptStore.transcriptPath(closeDir, name)).exists()).toBe(false);
  });
  test("a throwing transcript retain still clears every native map", async () => {
    const adapter = new NativeAgentAdapter();
    const name = "nax-throw-us-002-implementer";
    const handle = await openNativeSession(name, openOpts());
    sessionState.nativeSessionFailed.add(name);
    sessionState.nativeSessionLastUsage.set(name, { promptTokens: 10, anchorIndex: 0 });
    expect(collectionsHolding(name)).toEqual(exportedCollections());
    const retainSpy = spyOn(transcriptStore, "retainTranscript").mockRejectedValue(new Error("retain boom"));
    try {
      await expect(adapter.closeSession(handle)).rejects.toThrow("retain boom");
    } finally {
      retainSpy.mockRestore();
    }
    expect(collectionsHolding(name)).toEqual([]);
  });
});
