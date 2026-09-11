/**
 * Tests for `src/agents/native/model-resolver.ts` (US-1984).
 *
 * The module exports three symbols:
 *   - `ResolveStatus`           — type only, no test
 *   - `ResolveResult`           — type only, no test
 *   - `resolveNativeId`         — production resolver asks the override-aware
 *                                 cached client. Returns
 *                                 one of three states that the precheck check
 *                                 reads (`resolved` / `unresolved` / `error`).
 *
 * Adversarial finding: prior coverage of this module was indirect — the
 * precheck tests stub `_modelResolutionDeps.resolveNative` entirely, so the
 * two exported functions in `model-resolver.ts` were never exercised
 * directly. These tests are the unit coverage that closes the gap.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { resolveNativeId } from "@/agents/native/model-resolver";
import type { CatalogModelOverride, ProviderCatalogOverride } from "@/config/schema-types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function override(provider: string, models: CatalogModelOverride[]): ProviderCatalogOverride {
  return { provider, models };
}

function catalogModel(id: string): CatalogModelOverride {
  return {
    id,
    protocol: "openai-completions",
    contextWindow: 1_000_000,
    supportsTools: true,
    thinkingLevels: [],
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
}

const REAL_BUILD = _clientDeps.build;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveNativeId
//
// Drives the production resolver end-to-end. The cached client is built via
// _clientDeps.build, the same seam NativeAgentAdapter uses, so a test that
// captures builds counts "did we actually ask the catalog?" rather than
// trusting the stub returned what we hoped.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveNativeId", () => {
  function fakeClientWithModel(model: ResolvedModel): Client {
    return {
      model: async (_provider: string, _id: string) => model,
      listModels: async () => [model],
      pricing: () => model.pricing,
      stream: async function* () {},
      complete: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop" }),
      validate: () => {},
    };
  }

  function fakeClientModelRejecting(): Client {
    return {
      model: async () => {
        throw new Error("Unknown model in the pi-ai catalog");
      },
      listModels: async () => [],
      pricing: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      stream: async function* () {},
      complete: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop" }),
      validate: () => {},
    };
  }

  test("resolves an override through the override-aware client", async () => {
    const resolvedModel: ResolvedModel = {
      id: "claude-sonnet-5",
      provider: "anthropic",
      protocol: "anthropic-messages",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 1_000_000,
      supportsTools: true,
      thinkingLevels: [],
    };
    const buildMock = mock(async () => fakeClientWithModel(resolvedModel));
    _clientDeps.build = buildMock;

    const result = await resolveNativeId("anthropic", "claude-sonnet-5", [
      override("anthropic", [catalogModel("claude-sonnet-5")]),
    ]);

    expect(result.status).toBe("resolved");
    expect(result.hasPricing).toBe(true);
    expect(result.hasContextWindow).toBe(true);
    expect(buildMock).toHaveBeenCalledTimes(1);
  });

  test("returns 'resolved' with hasPricing=true when the catalog-resolved model declares pricing", async () => {
    const resolvedModel: ResolvedModel = {
      id: "claude-sonnet-5",
      provider: "anthropic",
      protocol: "anthropic-messages",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 1_000_000,
      supportsTools: true,
      thinkingLevels: [],
    };
    _clientDeps.build = async () => fakeClientWithModel(resolvedModel);

    const result = await resolveNativeId("anthropic", "claude-sonnet-5", []);

    expect(result.status).toBe("resolved");
    expect(result.hasPricing).toBe(true);
    expect(result.hasContextWindow).toBe(true);
  });

  test("returns 'unresolved' when the client built but client.model() rejected for this id", async () => {
    _clientDeps.build = async () => fakeClientModelRejecting();

    const result = await resolveNativeId("anthropic", "never-shipped", []);

    // AC1/AC2 contract: an id absent from the catalog is reported as
    // "unresolved" so the precheck check can emit a blocker at the site.
    expect(result.status).toBe("unresolved");
  });

  test("returns 'error' when getNativeClient rejects (catalog load failure, distinct from a per-id miss)", async () => {
    _clientDeps.build = async () => {
      throw new Error("catalog snapshot unavailable");
    };

    const result = await resolveNativeId("anthropic", "claude-sonnet-5", []);

    // AC6 contract: a transient catalog-load failure must surface as
    // "error" so the precheck check emits a warning, NOT a blocker.
    // A per-id catch-all that collapsed both into "unresolved" would
    // turn a transient outage into a tier-1 fail-fast and is the bug
    // AC6 exists to prevent.
    expect(result.status).toBe("error");
  });
});
