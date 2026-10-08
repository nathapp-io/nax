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
