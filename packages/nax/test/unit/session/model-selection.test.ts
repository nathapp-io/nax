import { describe, expect, test } from "bun:test";
import { selectModel } from "@/session/model-selection";

describe("selectModel", () => {
  test("hands the adapter a SessionModel with config pricing converted", () => {
    const out = selectModel({
      modelDef: { provider: "p", model: "m", pricing: { inputPer1M: 2, outputPer1M: 8 } },
      modelTier: "balanced",
    });
    expect(out).toEqual({
      modelDef: { provider: "p", model: "m", pricing: { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 } },
      modelTier: "balanced",
    });
  });

  test("omits modelTier when the model came from a pin", () => {
    expect("modelTier" in selectModel({ modelDef: { provider: "p", model: "m" } })).toBe(false);
  });
});
