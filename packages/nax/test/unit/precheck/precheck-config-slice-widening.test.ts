/**
 * AC9: precheck config slice defines the keys the model-resolution check walks.
 *
 * US-1984 widens `precheckConfigSelector` with `models`, `plan`, `acceptance`,
 * `autoMode`, `tdd`, and `routing`. The selector type alias lives in
 * `src/config/selectors.ts`; this test pins the contract by exercising the
 * selector end-to-end and asserting each key is present on the returned slice.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { precheckConfigSelector } from "@/config/selectors";

describe("precheckConfigSelector (US-1984 AC9)", () => {
  test("AC9: the selector slice defines models, plan, acceptance, autoMode, tdd, and routing", () => {
    const slice = precheckConfigSelector.select(DEFAULT_CONFIG);

    // Each of these keys MUST be defined on the slice. The selector widens
    // them so the model-resolution check can walk `models.*`, the literal
    // pin sites under `plan` / `acceptance` / `tdd` / `routing`, and the
    // escalation ladder under `autoMode`.
    expect(slice.models).toBeDefined();
    expect(slice.plan).toBeDefined();
    expect(slice.acceptance).toBeDefined();
    expect(slice.autoMode).toBeDefined();
    expect(slice.tdd).toBeDefined();
    expect(slice.routing).toBeDefined();
  });
});
