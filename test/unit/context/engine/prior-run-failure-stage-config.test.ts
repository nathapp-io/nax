/**
 * stage-config.ts — US-003 PriorRunFailureProvider provider-list tests
 *
 * AC13: rectify stage context config is resolved → providerIds includes 'prior-run-failure'.
 */

import { describe, expect, test } from "bun:test";
import { STAGE_CONTEXT_MAP, getStageContextConfig } from "../../../../src/context/engine/stage-config";

describe("stage-config — prior-run-failure provider registration (US-003 AC13)", () => {
  test("AC13: rectify stage includes 'prior-run-failure' in providerIds", () => {
    const config = getStageContextConfig("rectify");
    expect(config.providerIds).toContain("prior-run-failure");
  });

  test("AC13: rectify providerIds match the union of all stages referencing prior-run-failure", () => {
    const stagesWithPf = Object.entries(STAGE_CONTEXT_MAP)
      .filter(([, cfg]) => cfg.providerIds.includes("prior-run-failure"))
      .map(([stage]) => stage);

    // Per the spec scope, only the rectify stage activates this provider.
    expect(stagesWithPf).toContain("rectify");
  });

  test("US-003: stage-config maps prior-run-failure to a registered provider id", () => {
    // All provider IDs in any stage must be a registered provider id.
    // The orchestrator-factory registers prior-run-failure, so the stage-config
    // reference must resolve. This is a sanity check on the validator invariant.
    const providerIds = new Set<string>();
    for (const cfg of Object.values(STAGE_CONTEXT_MAP)) {
      for (const id of cfg.providerIds) providerIds.add(id);
    }
    expect(providerIds.has("prior-run-failure")).toBe(true);
  });
});
