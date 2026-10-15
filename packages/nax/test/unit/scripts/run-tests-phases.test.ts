import { describe, expect, test } from "bun:test";
import { E2E_PHASE, SUITE_PHASES, selectPhases } from "@scripts/run-tests-phases";

describe("selectPhases", () => {
  test("the default run is unit, integration, ui — never e2e", () => {
    expect(selectPhases([]).map((p) => p.name)).toEqual(["unit", "integration", "ui"]);
    expect(selectPhases(["--bail"])).toEqual(SUITE_PHASES);
  });

  test("--e2e runs only the e2e phase", () => {
    expect(selectPhases(["--e2e"])).toEqual([E2E_PHASE]);
  });

  test("the e2e phase keeps the old script's caps: 180 s wall clock, 60 s per test", () => {
    expect(E2E_PHASE).toEqual({ name: "e2e", dir: "test/e2e/", testTimeoutMs: 60_000, phaseTimeoutMs: 180_000 });
  });
});

/**
 * The worst wall-clock cost observed for a phase that ran every one of its files to completion
 * with no failing test of its own — unit 123.7s (nax#2491) and integration 145.8s (US-004 F1),
 * both on a loaded runner whose first, cold run of the suite pays Bun's warm-up. Each was killed
 * by the then-current budget while passing, which is the bug this pins.
 */
const OBSERVED_FULL_RUN_MS: Readonly<Record<string, number>> = {
  unit: 123_700,
  integration: 145_800,
};

describe("phase caps", () => {
  test("every cap leaves its phase at least 1.5x the worst observed full run", () => {
    for (const phase of SUITE_PHASES) {
      const observed = OBSERVED_FULL_RUN_MS[phase.name];
      if (observed === undefined) continue;
      expect(phase.phaseTimeoutMs, `${phase.name} (observed ${observed}ms)`).toBeGreaterThanOrEqual(observed * 1.5);
    }
  });
});
