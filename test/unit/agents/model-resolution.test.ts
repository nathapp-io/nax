/**
 * Tests for AA-006: Remove hardcoded claude-sonnet-4-5 model fallbacks
 *
 * Covers:
 * - resolveBalancedModelDef utility: fallback chain (config -> adapter default -> throw)
 */

import { describe, expect, test } from "bun:test";
import { resolveBalancedModelDef } from "@/agents/shared/model-resolution";
import type { ModelDef } from "@/config/schema";
import { makeNaxConfig, makeSparseNaxConfig } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// resolveBalancedModelDef — fallback chain utility
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveBalancedModelDef()", () => {
  test("returns ModelDef from config.models.balanced when present as object", () => {
    const config = makeNaxConfig({
      agent: { default: "claude" },
      models: {
        claude: {
          balanced: { provider: "anthropic", model: "claude-opus-4-5", env: {} },
        },
      },
    });

    const result = resolveBalancedModelDef(config);

    expect(result.model).toBe("claude-opus-4-5");
    expect(result.provider).toBe("anthropic");
  });

  test("resolves string shorthand in config.models.balanced via resolveModel", () => {
    const config = makeNaxConfig({
      agent: { default: "claude" },
      models: {
        claude: {
          balanced: "claude-opus-4-5",
        },
      },
    });

    const result = resolveBalancedModelDef(config);

    expect(result.model).toBe("claude-opus-4-5");
    expect(result.provider).toBe("anthropic");
  });

  test("falls back to adapterDefault when config has no balanced model", () => {
    const adapterDefault: ModelDef = { provider: "anthropic", model: "fallback-model", env: {} };

    const result = resolveBalancedModelDef(
      makeNaxConfig({ agent: { default: "claude" }, models: { claude: {} } }),
      adapterDefault,
    );

    expect(result.model).toBe("fallback-model");
  });

  test("falls back to adapterDefault when config.models is absent", () => {
    const adapterDefault: ModelDef = { provider: "anthropic", model: "fallback-model", env: {} };

    const result = resolveBalancedModelDef({} as Parameters<typeof resolveBalancedModelDef>[0], adapterDefault);

    expect(result.model).toBe("fallback-model");
  });

  test("throws when neither config.models.balanced nor adapterDefault is provided", () => {
    expect(() => resolveBalancedModelDef({} as Parameters<typeof resolveBalancedModelDef>[0])).toThrow(
      /no balanced model configured/i,
    );
  });

  test("throws when config has no balanced tier and adapterDefault is undefined", () => {
    // makeSparseNaxConfig (not makeNaxConfig): this must NOT merge over DEFAULT_CONFIG's
    // models.claude.balanced ("sonnet") — the test needs models.claude to carry only "fast".
    const config = makeSparseNaxConfig({
      agent: { default: "claude" },
      models: { claude: { fast: { provider: "anthropic", model: "haiku" } } },
    });

    expect(() => resolveBalancedModelDef(config, undefined)).toThrow();
  });
});
