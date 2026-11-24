import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  E2E_PHASE,
  phaseArgs,
  SUITE_PARALLEL_WORKERS,
  SUITE_PHASES,
  selectPhases,
  suiteParallelWorkers,
} from "@scripts/run-tests-phases";

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
    expect(E2E_PHASE.parallel).toBeUndefined();
  });
});

/**
 * The worst wall-clock cost observed for a phase that ran every one of its files to completion
 * with no failing test of its own — unit 123.7s (nax#2491) and integration 145.8s (US-004 F1),
 * both on a loaded runner whose first, cold run of the suite pays Bun's warm-up. Each was killed
 * by the then-current budget while passing, which is the bug this pins.
 *
 * `ui` did not get to finish: a whole-repo run on a loaded runner was killed at 30.11s with
 * 910 tests passing and nothing failing, so 30.1s is a *lower bound* on what that phase cost
 * there. It idles at ~10.6s. Recording the bound rather than the idle cost is the point: a
 * budget derived from the happy path is what made the gate red.
 */
const OBSERVED_FULL_RUN_MS: Readonly<Record<string, number>> = {
  unit: 123_700,
  integration: 145_800,
  ui: 30_100,
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

const phase = (name: string) => {
  const found = SUITE_PHASES.find((p) => p.name === name);
  if (found === undefined) throw new Error(`no ${name} phase`);
  return found;
};

describe("parallel phases", () => {
  test("unit and integration run in parallel; ui stays serial", () => {
    expect(phase("unit").parallel).toBe(true);
    expect(phase("integration").parallel).toBe(true);
    expect(phase("ui").parallel).toBeUndefined();
  });

  test("the default worker count is 4", () => {
    expect(SUITE_PARALLEL_WORKERS).toBe(4);
    expect(suiteParallelWorkers({})).toBe(4);
  });

  test("NAX_TEST_PARALLEL_WORKERS overrides the worker count", () => {
    expect(suiteParallelWorkers({ NAX_TEST_PARALLEL_WORKERS: "2" })).toBe(2);
    expect(suiteParallelWorkers({ NAX_TEST_PARALLEL_WORKERS: "1" })).toBe(1);
    expect(suiteParallelWorkers({ NAX_TEST_PARALLEL_WORKERS: "" })).toBe(4);
  });

  test.each([["0"], ["-1"], ["two"], ["1.5"]])("rejects NAX_TEST_PARALLEL_WORKERS=%s", (value) => {
    expect(() => suiteParallelWorkers({ NAX_TEST_PARALLEL_WORKERS: value })).toThrow("positive integer");
  });
});

describe("phaseArgs", () => {
  test("a parallel phase adds --parallel=<n> --no-isolate, since --parallel alone was slower than serial", () => {
    expect(phaseArgs(phase("unit"), { bail: false, workers: 4 })).toEqual([
      "test",
      "test/unit/",
      "--timeout=5000",
      "--parallel=4",
      "--no-isolate",
    ]);
  });

  test("a serial phase gets no parallel flags", () => {
    expect(phaseArgs(phase("ui"), { bail: false, workers: 4 })).toEqual(["test", "test/ui/", "--timeout=5000"]);
  });

  test("one worker runs a parallel phase serially", () => {
    expect(phaseArgs(phase("integration"), { bail: false, workers: 1 })).toEqual([
      "test",
      "test/integration/",
      "--timeout=5000",
    ]);
  });

  test("--bail is forwarded", () => {
    expect(phaseArgs(phase("ui"), { bail: true, workers: 4 })).toEqual([
      "test",
      "test/ui/",
      "--timeout=5000",
      "--bail",
    ]);
  });
});

/**
 * `bun run test test/e2e/fail.test.ts` used to run unit, integration and ui and report
 * their exit code, ignoring the file it was told to run (review e684, finding 11). The
 * package directory below is the frame the arguments are resolved in; no directory has
 * to exist, because selection is path arithmetic.
 */
const PKG = resolve(import.meta.dir, "fixture-package");

const selectedNames = (phases: readonly { readonly name: string }[]): string[] => phases.map((p) => p.name);

describe("selectPhases — explicit test files", () => {
  test("an explicit e2e file selects the e2e phase alone, with its own caps", () => {
    const phases = selectPhases(["test/e2e/a.test.ts"], PKG);

    expect(selectedNames(phases)).toEqual(["e2e"]);
    expect(phases[0]?.files).toEqual([join(PKG, "test/e2e/a.test.ts")]);
    expect(phases[0]?.testTimeoutMs).toBe(E2E_PHASE.testTimeoutMs);
    expect(phases[0]?.phaseTimeoutMs).toBe(E2E_PHASE.phaseTimeoutMs);
  });

  test("one unit file and one integration file select those two phases, in suite order, each with its own file", () => {
    const phases = selectPhases(["test/integration/b.test.ts", "test/unit/a.test.ts"], PKG);

    expect(selectedNames(phases)).toEqual(["unit", "integration"]);
    expect(phases[0]?.files).toEqual([join(PKG, "test/unit/a.test.ts")]);
    expect(phases[1]?.files).toEqual([join(PKG, "test/integration/b.test.ts")]);
  });

  test("a file under no phase directory is refused, naming the file", () => {
    expect(() => selectPhases(["docs/x.test.ts"], PKG)).toThrow("docs/x.test.ts");
  });

  test("a basename beginning with two dots is a valid file, not a parent-directory escape", () => {
    const phases = selectPhases(["test/unit/..case.test.ts"], PKG);

    expect(selectedNames(phases)).toEqual(["unit"]);
    expect(phases[0]?.files).toEqual([join(PKG, "test/unit/..case.test.ts")]);
  });

  test("an absolute path outside the package directory is still refused", () => {
    expect(() => selectPhases(["/elsewhere/test/unit/a.test.ts"], PKG)).toThrow("/elsewhere/test/unit/a.test.ts");
  });

  test("--e2e is ignored when explicit files are given", () => {
    const phases = selectPhases(["test/unit/a.test.ts", "--e2e"], PKG);

    expect(selectedNames(phases)).toEqual(["unit"]);
    expect(phases[0]?.files).toEqual([join(PKG, "test/unit/a.test.ts")]);
  });

  test("a selected phase keeps its parallel setting", () => {
    const phases = selectPhases(["test/unit/a.test.ts"], PKG);

    expect(phases[0]?.parallel).toBe(true);
  });
});

describe("selectPhases — arguments that are not explicit files", () => {
  test("a flag alone selects the suite", () => {
    expect(selectPhases(["--bail"], PKG)).toEqual(SUITE_PHASES);
  });

  test("--e2e alone still selects the e2e phase", () => {
    expect(selectPhases(["--e2e"], PKG)).toEqual([E2E_PHASE]);
  });

  test("a bare name filter is not a file, so it selects the suite", () => {
    expect(selectPhases(["parser"], PKG)).toEqual(SUITE_PHASES);
  });
});

describe("phaseArgs with explicit files", () => {
  test("the selected files replace the phase directory", () => {
    const [withFiles] = selectPhases(["test/unit/a.test.ts", "test/unit/b.test.ts"], PKG);

    expect(phaseArgs(withFiles, { bail: false, workers: 1 })).toEqual([
      "test",
      join(PKG, "test/unit/a.test.ts"),
      join(PKG, "test/unit/b.test.ts"),
      "--timeout=5000",
    ]);
  });

  test("a parallel phase keeps --parallel and --no-isolate over explicit files", () => {
    const [withFiles] = selectPhases(["test/unit/a.test.ts"], PKG);

    expect(phaseArgs(withFiles, { bail: true, workers: 4 })).toEqual([
      "test",
      join(PKG, "test/unit/a.test.ts"),
      "--timeout=5000",
      "--parallel=4",
      "--no-isolate",
      "--bail",
    ]);
  });
});
