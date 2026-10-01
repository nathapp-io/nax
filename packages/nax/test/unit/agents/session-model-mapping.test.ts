import { describe, expect, test } from "bun:test";
import { toSessionModel } from "@/agents/session-model-mapping";
import type { ModelDef } from "@/config/schema-types";

describe("toSessionModel", () => {
  test("copies provider and model", () => {
    expect(toSessionModel({ provider: "openai", model: "openai/gpt-5.4-mini" })).toEqual({
      provider: "openai",
      model: "openai/gpt-5.4-mini",
    });
  });

  test("omits absent fields", () => {
    const out = toSessionModel({ provider: "p", model: "m" });
    expect("pricing" in out).toBe(false);
    expect("contextWindow" in out).toBe(false);
    expect("env" in out).toBe(false);
  });

  test("carries contextWindow and env unchanged", () => {
    const def: ModelDef = { provider: "p", model: "m", contextWindow: 50_000, env: { A: "1" } };
    expect(toSessionModel(def)).toEqual({ provider: "p", model: "m", contextWindow: 50_000, env: { A: "1" } });
  });

  test("base-missing-cache: converts config pricing; absent cache rates take the base input rate", () => {
    const def: ModelDef = { provider: "p", model: "m", pricing: { inputPer1M: 3, outputPer1M: 15 } };
    expect(toSessionModel(def).pricing).toEqual({ input: 3, output: 15, cacheRead: 3, cacheWrite: 3 });
  });

  test("tier-missing-cache: each tier's absent cache rates take that tier's own input rate", () => {
    const def: ModelDef = {
      provider: "p",
      model: "m",
      pricing: {
        inputPer1M: 3,
        outputPer1M: 15,
        cacheReadPer1M: 0.3,
        cacheCreationPer1M: 3.75,
        tiers: [{ inputPer1M: 6, outputPer1M: 22.5, inputTokensAbove: 200_000 }],
      },
    };
    expect(toSessionModel(def).pricing).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [{ input: 6, output: 22.5, cacheRead: 6, cacheWrite: 6, inputTokensAbove: 200_000 }],
    });
  });
});
