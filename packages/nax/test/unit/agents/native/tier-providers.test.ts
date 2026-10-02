/**
 * `nativeTierProviders` — the provider -> tiers derivation shared by the
 * native-credentials precheck and by callers outside nax (US-001).
 *
 * The rule it pins down: only the default agent's root `models.native` map is
 * read, an id's provider is the prefix before "/" and is never guessed, and a
 * provider declared in `agent.native.catalogOverrides` is skipped because it
 * authenticates through the override.
 */

import { describe, expect, test } from "bun:test";
import { nativeTierProviders } from "@nathapp/nax-agent";
import { makeNaxConfig } from "@test/helpers";

// AC1-AC6 feed the reader a full NaxConfig (DEFAULT_CONFIG merged), so they stay with nax's config; the plain-object contract test lives in nax-agent.

describe("nativeTierProviders", () => {
  test("AC1: maps a provider to every tier that names it, in tier order", () => {
    const config = makeNaxConfig({
      models: {
        native: { fast: "openai/gpt-a", balanced: "deepseek/ds-b", powerful: "openai/gpt-c" },
      },
    });

    expect(nativeTierProviders(config).get("openai")).toEqual(["fast", "powerful"]);
  });

  test("AC2: maps a provider used by one tier to just that tier", () => {
    const config = makeNaxConfig({
      models: {
        native: { fast: "openai/gpt-a", balanced: "deepseek/ds-b", powerful: "openai/gpt-c" },
      },
    });

    expect(nativeTierProviders(config).get("deepseek")).toEqual(["balanced"]);
  });

  test("AC3: reads the provider from an object entry's model id", () => {
    const config = makeNaxConfig({
      models: {
        native: {
          fast: { provider: "anthropic", model: "anthropic/claude-x" },
          balanced: "deepseek/ds-b",
          powerful: "deepseek/ds-b",
        },
      },
    });

    const byProvider = nativeTierProviders(config);

    expect(byProvider.has("anthropic")).toBe(true);
    expect(byProvider.get("anthropic")).toEqual(["fast"]);
  });

  test("AC4: skips an id with no provider prefix instead of guessing one", () => {
    const config = makeNaxConfig({
      models: { native: { fast: "gpt-a", balanced: "ds-b", powerful: "gpt-c" } },
    });

    expect(nativeTierProviders(config).size).toBe(0);
  });

  test("AC5: skips a provider declared in agent.native.catalogOverrides", () => {
    const config = makeNaxConfig({
      models: { native: { fast: "local/m", balanced: "local/m2", powerful: "local/m3" } },
      agent: { native: { catalogOverrides: [{ provider: "local", models: [{ id: "m" }] }] } },
    });

    expect(nativeTierProviders(config).size).toBe(0);
  });

  test("AC6: returns an empty map when models.native is absent", () => {
    const config = makeNaxConfig({ models: {} });

    expect(nativeTierProviders(config).size).toBe(0);
  });
});
