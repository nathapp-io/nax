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
      stopAfterSameKeyRepeats: 12,
      stopAfterNoProgressSeconds: 900,
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

  // nax#2017: the no-progress time axis is derived from the tool-call-only idle
  // watchdog when the operator has not set it, so a slow spin ends as
  // `fail-spin` before the watchdog cancels it as `fail-stale`.
  test("AC5: halves the idle watchdog's tool-call-only timeout when it is 1200", () => {
    const config = agentManagerConfigSelector.select(
      makeNaxConfig({ agent: { idleWatchdog: { toolCallOnlyIdleTimeoutSeconds: 1200 } } }),
    );

    expect(selectSpinBreakerSettings(config).stopAfterNoProgressSeconds).toBe(600);
  });

  test("AC6: honours an explicit stopAfterNoProgressSeconds over the watchdog-derived value", () => {
    const config = agentManagerConfigSelector.select(
      makeNaxConfig({
        agent: {
          spinBreaker: { stopAfterNoProgressSeconds: 300 },
          idleWatchdog: { toolCallOnlyIdleTimeoutSeconds: 1200 },
        },
      }),
    );

    expect(selectSpinBreakerSettings(config).stopAfterNoProgressSeconds).toBe(300);
  });

  test("AC7: falls back to 900 when the idle watchdog mode is 'off'", () => {
    const config = agentManagerConfigSelector.select(makeNaxConfig({ agent: { idleWatchdog: { mode: "off" } } }));

    expect(selectSpinBreakerSettings(config).stopAfterNoProgressSeconds).toBe(900);
  });

  test("AC8: falls back to 900 when the config is undefined", () => {
    expect(selectSpinBreakerSettings(undefined).stopAfterNoProgressSeconds).toBe(900);
  });

  // A disabled watchdog never runs, so deriving half its timeout would drive the
  // time axis off a watchdog that is off — fall back to 900 like `mode: "off"`.
  test("falls back to 900 when the idle watchdog is disabled", () => {
    const config = agentManagerConfigSelector.select(
      makeNaxConfig({ agent: { idleWatchdog: { enabled: false, toolCallOnlyIdleTimeoutSeconds: 1200 } } }),
    );

    expect(selectSpinBreakerSettings(config).stopAfterNoProgressSeconds).toBe(900);
  });
});
