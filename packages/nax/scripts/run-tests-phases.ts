import { isAbsolute, relative, resolve, sep } from "node:path";

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
  /**
   * Absolute test files to run INSTEAD of `dir`, set only by `selectPhases` when
   * the run names its files on the command line.
   */
  readonly files?: readonly string[];
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
 * The `bun test` arguments for one phase. A phase carrying selected files runs
 * exactly those instead of the directory; a parallel phase gets `--no-isolate`
 * with `--parallel`: `--parallel` alone implies `--isolate`, which re-imports every
 * module per file and was slower than serial. One worker runs the phase serially
 * rather than as a single shared-registry worker.
 */
export function phaseArgs(phase: Phase, opts: { readonly bail: boolean; readonly workers: number }): string[] {
  return [
    "test",
    ...(phase.files ?? [phase.dir]),
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

/**
 * Every phase a run can select, in the order the wrapper reports them: a selected
 * set is always emitted in this order, never in argument order, so a run's phases
 * are reproducible from its command line.
 */
const ALL_PHASES: readonly Phase[] = [...SUITE_PHASES, E2E_PHASE];

/** The suffix that makes an argument an explicit test file rather than a filter. */
const EXPLICIT_TEST_FILE = /\.test\.tsx?$/;

function isExplicitTestFile(arg: string): boolean {
  return !arg.startsWith("-") && EXPLICIT_TEST_FILE.test(arg);
}

/** True when `file` (absolute) lies under `dir`, resolved against `packageDir`. */
function isUnderPhase(file: string, dir: string, packageDir: string): boolean {
  const rel = relative(resolve(packageDir, dir), file);
  // An escape is `..` itself or `..` followed by a separator. A bare `..` prefix
  // is not an escape: `relative()` returns `..case.test.ts` for a file of that
  // name, and that file is under the phase directory.
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The phases a run selects.
 *
 * Arguments are otherwise ignored: a flag or a bare name filter selects the whole
 * suite exactly as before. An explicit `.test.ts` / `.test.tsx` file is resolved
 * against `packageDir` and routed to the phase whose directory holds it, and a file
 * under none of them is refused here — before any phase runs — because `bun test`
 * would otherwise run it as a filter and report the suite's result instead.
 *
 * `--e2e` is ignored once files are named: the files already say which phases run.
 */
export function selectPhases(args: readonly string[], packageDir: string = process.cwd()): readonly Phase[] {
  const files = args.filter(isExplicitTestFile).map((file) => resolve(packageDir, file));
  if (files.length === 0) return args.includes("--e2e") ? [E2E_PHASE] : SUITE_PHASES;

  const selected = new Map<string, string[]>();
  for (const file of files) {
    const phase = ALL_PHASES.find((candidate) => isUnderPhase(file, candidate.dir, packageDir));
    if (phase === undefined) {
      throw new Error(`[run-tests] ${file} is not under test/unit/, test/integration/, test/ui/ or test/e2e/`);
    }
    const own = selected.get(phase.name) ?? [];
    own.push(file);
    selected.set(phase.name, own);
  }

  return ALL_PHASES.filter((phase) => selected.has(phase.name)).map((phase) => ({
    ...phase,
    files: selected.get(phase.name) ?? [],
  }));
}
