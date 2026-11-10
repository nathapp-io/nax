/**
 * The phases `scripts/run-tests.ts` runs. Kept pure (no spawning) so the
 * selection is unit-testable; the wrapper owns the timeouts and the reaping.
 */
export type Phase = {
  name: string;
  dir: string;
  /** Per-test timeout passed to Bun. */
  testTimeoutMs: number;
  /** Wall-clock cap for the whole phase. */
  phaseTimeoutMs: number;
  /**
   * Run the phase's files over `suiteParallelWorkers()` workers with
   * `bun test --parallel=<n> --no-isolate`. Absent: serial.
   */
  parallel?: true;
};

/**
 * Workers for a parallel phase: the count CI's confined step uses. Probed on the
 * unconfined nax suite (Bun 1.4.4, 3 runs, every sandbox-skipped test included):
 * unit 90s -> 27-30s, integration 91-117s -> 31-41s, the same test and skip counts
 * as serial, and no failure.
 */
export const SUITE_PARALLEL_WORKERS = 4;

/** Set to 1 to run every phase serially, e.g. on a constrained runner. */
export const SUITE_PARALLEL_WORKERS_ENV = "NAX_TEST_PARALLEL_WORKERS";

export function suiteParallelWorkers(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[SUITE_PARALLEL_WORKERS_ENV];
  if (raw === undefined || raw === "") return SUITE_PARALLEL_WORKERS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`[run-tests] ${SUITE_PARALLEL_WORKERS_ENV}=${raw}: the worker count must be a positive integer`);
  }
  return Number(raw);
}

/**
 * The `bun test` arguments for one phase. A parallel phase gets `--no-isolate`
 * with `--parallel`: `--parallel` alone implies `--isolate`, which re-imports every
 * module per file and was slower than serial. One worker runs the phase serially
 * rather than as a single shared-registry worker.
 */
export function phaseArgs(phase: Phase, opts: { readonly bail: boolean; readonly workers: number }): string[] {
  return [
    "test",
    phase.dir,
    `--timeout=${phase.testTimeoutMs}`,
    ...(phase.parallel === true && opts.workers > 1 ? [`--parallel=${opts.workers}`, "--no-isolate"] : []),
    ...(opts.bail ? ["--bail"] : []),
  ];
}

export const SUITE_PHASES: readonly Phase[] = [
  // 240s, not 120s: the unit suite is ~21.7k tests across ~1.4k files, and a
  // fully-passing run was observed at 123.7s wall on a loaded runner — killed
  // by the old 120s budget with zero failing tests. The budget exists to bound
  // hangs (per-test timeout stays 5s; the group reap still fires on overrun),
  // so it must not sit at the suite's legitimate steady-state cost.
  { name: "unit", dir: "test/unit/", testTimeoutMs: 5_000, phaseTimeoutMs: 240_000, parallel: true },
  // 300s, not 120s: the same overrun as the unit phase, one phase later. A cold
  // `bun test test/integration/ --timeout=5000` was observed at 145.8s wall
  // (1670 tests, 164 files, every file run to completion and no extra failure),
  // while the same phase warm costs ~60s; the 120s budget killed the cold run
  // with nothing to report, which is not a test result. See the note above.
  { name: "integration", dir: "test/integration/", testTimeoutMs: 5_000, phaseTimeoutMs: 300_000, parallel: true },
  // 120s, not 30s: the same overrun again, one phase later. The ui phase costs ~10.6s warm
  // on an idle machine, but a whole-repo run on a loaded runner was killed at 30.11s with 910
  // passing tests and no failure of its own — the React reconciliation warning in that log is
  // not an assertion. A budget that only covers the idle cost turns a loaded runner into a red
  // gate, so the cap is set from the observation, not from the happy path.
  { name: "ui", dir: "test/ui/", testTimeoutMs: 5_000, phaseTimeoutMs: 120_000 },
];

/**
 * `test/e2e/` is outside the default run by design (CI runs it as its own step).
 * The caps are the ones the old `timeout -k 5s 180s bun test test/e2e/ --timeout=60000`
 * script used; running it here makes them portable (stock macOS has no GNU `timeout`).
 */
export const E2E_PHASE: Phase = { name: "e2e", dir: "test/e2e/", testTimeoutMs: 60_000, phaseTimeoutMs: 180_000 };

export function selectPhases(argv: readonly string[]): readonly Phase[] {
  return argv.includes("--e2e") ? [E2E_PHASE] : SUITE_PHASES;
}
