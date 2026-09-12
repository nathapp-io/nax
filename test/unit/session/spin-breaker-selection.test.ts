import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { agentManagerConfigSelector } from "@/config";
import { selectSpinBreakerSettings } from "@/session/spin-breaker-selection";

describe("selectSpinBreakerSettings", () => {
  test("resolves concrete numbers from an empty config", () => {
    expect(selectSpinBreakerSettings(undefined)).toEqual({
      enabled: true,
      nudgeAfterRepeats: 25,
      maxNudges: 3,
      stopAfterRepeats: 50,
      recentKeyWindow: 64,
    });
  });

  test("honours overrides", () => {
    const config = agentManagerConfigSelector.select(
      makeNaxConfig({ agent: { spinBreaker: { nudgeAfterRepeats: 10, stopAfterRepeats: 20, maxNudges: 2 } } }),
    );

    const resolved = selectSpinBreakerSettings(config);

    expect(resolved.nudgeAfterRepeats).toBe(10);
    expect(resolved.stopAfterRepeats).toBe(20);
    expect(resolved.maxNudges).toBe(2);
  });
});
