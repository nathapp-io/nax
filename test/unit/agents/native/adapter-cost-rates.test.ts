/**
 * nax#1843/#1847: adapter.ts built `rates` inline at each call site and
 * discarded `catalog.cacheRead` / `catalog.cacheWrite` / `catalog.tiers`.
 * `estimateCostUsd` unit tests (models.test.ts) can pass while this bug is
 * live -- they hand `estimateCostUsd` a rate object directly, so they never
 * exercise the forwarding that was broken. Both #1841's config wiring and
 * #1836's cache rates shipped exactly this shape of defect: correct in the
 * pure function, inert in production because the value never reached it.
 *
 * These tests drive the real `NativeAgentAdapter.complete()` / `sendTurn()`
 * call paths through a fake client whose `pricing()` returns nonzero cache
 * rates, and assert on the computed dollar amount -- so a regression that
 * re-discards the catalog's rates shows up as a wrong number, not a missed
 * call.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "@nathapp/nax-ai";
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

const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

// Catalog rates for the worked example in docs/architecture/nax-ai-surface.md:
// input $2/1M, cacheRead $0.2/1M (10% of input, but a REAL per-model number
// here -- not the acpx heuristic).
const CATALOG_PRICING = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

function options(): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all" },
  };
}

describe("catalog cache rates reach cost through the adapter, not just estimateCostUsd", () => {
  test("complete() prices a cache read at the catalog's cacheRead rate, not the full input rate", async () => {
    _clientDeps.build = async () => ({
      model: async () => MODEL,
      listModels: async () => [MODEL],
      pricing: () => CATALOG_PRICING,
      stream: async function* stream() {},
      complete: async () => ({
        text: "ok",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
        stopReason: "stop",
      }),
      validate: () => {},
    });

    const result = await new NativeAgentAdapter().complete("hi", options());

    // If the catalog's cacheRead were discarded (the bug), this would fall
    // back to the full input rate: 1M cache-read tokens x $2/1M = $2.00.
    // The catalog's real cacheRead rate is $0.2/1M => $0.20.
    expect(result.estimatedCostUsd).toBeCloseTo(0.2, 6);
  });

  test("complete() prices a cache write at the catalog's cacheWrite rate, not the full input rate", async () => {
    _clientDeps.build = async () => ({
      model: async () => MODEL,
      listModels: async () => [MODEL],
      pricing: () => CATALOG_PRICING,
      stream: async function* stream() {},
      complete: async () => ({
        text: "ok",
        usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 },
        stopReason: "stop",
      }),
      validate: () => {},
    });

    const result = await new NativeAgentAdapter().complete("hi", options());

    // Discarded cacheWrite would fall back to input ($2/1M => $2.00). The
    // catalog's real cacheWrite rate is $2.5/1M => $2.50 -- the OPPOSITE
    // direction of error from the cache-read case, so a fallback-to-input
    // bug would not show up as "always cheaper" or "always pricier".
    expect(result.estimatedCostUsd).toBeCloseTo(2.5, 6);
  });

  test("sendTurn prices a cache write at the catalog's cacheWrite rate, not the full input rate", async () => {
    _clientDeps.build = async () => ({
      model: async () => MODEL,
      listModels: async () => [MODEL],
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
      resolvedPermissions: { mode: "approve-all" },
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
