#!/usr/bin/env bun
/**
 * Coverage gate: runs the gated suites with coverage, parses coverage/lcov.info,
 * and fails if overall line or function coverage drops below the floor.
 *
 * Why a custom script: Bun's `coverageThreshold` only exits non-zero when the
 * `text` reporter is enabled (documented, and outside `--parallel`); with the
 * lcov-only reporter this repo configures, a run below the threshold still exits
 * 0. That is the real cause of the "Bun computes but does not enforce" note this
 * comment used to carry. Even with `text` on, `coverageThreshold` has no per-file
 * ratchet and no missing-file guard, so the floors stay enforced here by parsing
 * the lcov report.
 *
 * Scope: whichever of `test/unit/`, `test/integration/` and `test/ui/` the package
 * has, in ONE `bun test` invocation, measuring the package's `src/` only — see
 * AGGREGATE_SCOPE_PREFIX. The package is the current directory, or `--package=<dir>`;
 * its baseline lives in `<package>/scripts/baselines/`. In nax it used to be the unit
 * suite alone, on the grounds that Bun
 * "cannot merge coverage across the separate process-group invocations the wrapper
 * uses" and that the other suites "add little source coverage" — the first is true
 * of scripts/run-tests.ts's phases but not of a single invocation given all three
 * directories, and the second was measured false on 2026-08-30: merging moved
 * aggregate lines 88.58% -> 91.59% and took 94 files below the per-file floor down
 * to 62, with no test written. `test/e2e/` stays out; it is excluded from
 * `bun run test` by design and runs as its own CI step.
 *
 * Per-file floor: the aggregate floor above can hide a single file collapsing
 * (e.g. 12% -> 0%) inside an 87%-covered repo. A second ratchet, in the same
 * style as check-file-sizes.ts / check-nax-error.ts, tracks every `src/`
 * file whose unit-suite line coverage sits below PER_FILE_FLOOR. Files already
 * below it are grandfathered in <package>/scripts/baselines/coverage-per-file-baseline.json
 * at their current pct; the gate then fails if a NEW file drops below the floor,
 * or a grandfathered file's coverage falls further below its recorded baseline.
 * Both floors read the same merged report, so a file covered only by an
 * integration or UI test counts. `test/e2e/` is still outside both.
 *
 * Missing-file guard (GitHub #1779): a file can be executed by a passing test and
 * still have NO `SF:` record in the report — deterministically, depending on which
 * other test files share the run. Without a guard that file silently leaves the
 * below-floor list and `--update-baseline` deletes its entry, so the ratchet reads
 * a disappearance as a graduation. A baselined file that is absent from the report
 * while still present on disk is therefore an ERROR, not a pass, unless it is listed
 * in UNMEASURABLE below; and `--update-baseline` carries such an entry forward at its
 * recorded number rather than dropping it.
 *
 * Usage:
 *   bun run test:coverage          # run + enforce floors (CI mode)
 *   bun run test:coverage:report   # run + print summary, never fail
 *   bun run test:coverage:update   # run + save new per-file baseline (--update-baseline)
 *   bun run test:coverage:list     # run + print all below-floor files (--list)
 *   --require-all-files            also fail on any src/ file with code that has no record in the report
 *   (each package script calls this file from its own package directory)
 *
 * Exit codes:
 *   0 — coverage at/above floor (or --report / --update-baseline / --list)
 *   1 — below a floor, the test run failed, or lcov.info was not produced
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CoverageEnvironment, finishCoverage } from "#scripts/coverage-gate-mode";
import { coverageTestPaths } from "#scripts/coverage-test-selection";
import { gateBaselinePath, gatePackageRoot } from "#scripts/lib/package-root";
import { type CapturedTail, captureStream, type StreamCapture } from "#scripts/quiet-capture";

const ROOT = gatePackageRoot();
const LCOV_PATH = join(ROOT, "coverage", "lcov.info");
const PER_FILE_BASELINE_FILE = gateBaselinePath(ROOT, "coverage-per-file-baseline.json");

/** Enforced floor. Matches the documented 80% rule (.claude/rules/common/testing.md). */
const FLOOR = { lines: 0.8, functions: 0.8 };

/**
 * Path prefix both floors measure.
 *
 * `coverageSkipTestFiles` drops `*.test.ts` but NOT `test/helpers/**` or
 * `test/preload.ts`, which do get `SF:` records. Summing every record therefore
 * folded ~5,000 lines of test scaffolding into the aggregate and understated the
 * source numbers by over a point (measured 2026-08-30: 94.28% all-records vs
 * 95.56% src-only). The per-file ratchet was always scoped; the aggregate is now
 * scoped the same way, so both floors describe the same thing.
 */
const AGGREGATE_SCOPE_PREFIX = "src/";

const SCOPE_PREFIXES: readonly string[] = [AGGREGATE_SCOPE_PREFIX];

function inScope(file: string, prefixes: string | readonly string[]): boolean {
  return (typeof prefixes === "string" ? [prefixes] : prefixes).some((p) => file.startsWith(p));
}

/** Per-file floor for the second ratchet described above. */
const PER_FILE_FLOOR = 0.8;
const PER_FILE_SCOPE_PREFIXES = SCOPE_PREFIXES;
/** Baseline comparisons ignore drift below this to absorb run-to-run rounding noise. */
const PER_FILE_EPSILON = 0.001;

/**
 * Files known to be absent from the report despite being executed by a passing test,
 * with the reason. Listed here so the missing-file guard reports them without failing
 * the run — every other absence is a new instance of #1779 and must fail.
 *
 * Currently EMPTY, and keep it that way if you can. An entry is a measurement hole, not
 * an exemption from the floor: the file's recorded baseline number is still carried
 * forward and still ratcheted the moment the report starts including it again.
 *
 * It held `src/prompts/loader.ts` until 2026-08-30. #1779 is NOT fixed upstream — its
 * two-file repro still produces no `SF:` record on Bun 1.4.0 — but that file now records
 * normally in the gated run, and the baseline it guarded is gone, so the entry described
 * nothing. A stale entry is worse than none: it would let a genuine disappearance pass.
 */
export const UNMEASURABLE: Record<string, string> = {};

/** Suites a package may have; the gate runs the ones that exist, in ONE invocation. `test/e2e/` is deliberately out. */
export const CANDIDATE_SUITES = ["test/unit/", "test/integration/", "test/ui/"] as const;

export function gatedSuites(root: string, exists: (path: string) => boolean = existsSync): string[] {
  return CANDIDATE_SUITES.filter((suite) => exists(join(root, suite)));
}

/**
 * Wall-clock cap for the coverage run, in ms. nax's merged run took ~224s in CI on
 * 2026-11-09 (about 55s when the old 300s cap was set), so the cap was raised to 480s.
 */
export const RUN_TIMEOUT_MS = 480_000;

/** The child-process options the coverage run needs; narrowed so tests can read them back. */
export interface SpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: "pipe" | "inherit";
  stderr: "pipe" | "inherit";
  detached: boolean;
}

/**
 * How the child run is launched. Every field is a test seam: production passes nothing and
 * gets the 480s deadline and the gated suites, while the capture tests inject a short
 * deadline, a fixture command and sinks instead of this process's own stdout/stderr.
 */
export interface RunCoverageOptions {
  /** Wall-clock deadline for the child run, in ms. Defaults to RUN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** The child command. Defaults to `bun test <gated suites> --coverage`. */
  command?: readonly string[];
  /** Quiet capture. Defaults to the parent's `AGENT === "1"`. */
  quiet?: boolean;
  /** Where replayed stdout goes. Defaults to this process's stdout. */
  out?: (text: string) => void;
  /** Where replayed stderr goes. Defaults to this process's stderr. */
  err?: (text: string) => void;
}

export interface Totals {
  linesFound: number;
  linesHit: number;
  fnFound: number;
  fnHit: number;
}

/**
 * The pass/skip/fail block bun prints at the end of a run, from the `N pass` line
 * through the `Ran N tests …` line. Empty when bun printed none (crash, timeout).
 */
export function extractTestSummary(output: string): string {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => /^\s*\d+ pass\s*$/.test(l));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i >= start && /^Ran \d+ tests?\b/.test(l));
  return end === -1 ? "" : `${lines.slice(start, end + 1).join("\n")}\n`;
}

/** The live captures of a quiet run's two streams. */
interface Captures {
  stdout: StreamCapture;
  stderr: StreamCapture;
}

/** The captured tail of each stream of a quiet run. */
interface Tails {
  stdout: CapturedTail;
  stderr: CapturedTail;
}

/** Where a replayed run writes: this process's own streams in production, a sink in tests. */
type Write = (text: string) => void;

/** What a run settled as: its own exit status plus both tails, or the deadline. */
type Outcome = { kind: "settled"; exitCode: number; tails: Tails | null } | { kind: "deadline" };

/** Kills the child's whole process group, so a descendant cannot keep the pipes — or the run — alive. */
function killGroup(child: Bun.Subprocess): void {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already empty; fall back to the leader, which may be a zombie.
    try {
      child.kill("SIGKILL");
    } catch {
      // Nothing left to kill: the run finished while the deadline callback was firing.
    }
  }
}

/**
 * Waits for the child's EXIT and both streams' EOF under ONE deadline.
 *
 * Keeping the original deadline across the drain is the point of this function: the timer
 * is not cleared when the child exits, because exit and EOF are separate events and a
 * descendant can hold a pipe open indefinitely. Whichever completes first decides the
 * outcome. On expiry the process group is killed and the still-pending capture is
 * detached rather than awaited, so `runCoverage` cannot block past its deadline.
 */
async function settleUnderDeadline(
  child: Bun.Subprocess,
  captures: Captures | null,
  timeoutMs: number,
): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      killGroup(child);
      resolve({ kind: "deadline" });
    }, timeoutMs);
  });
  const settled = (async (): Promise<Outcome> => {
    const exitCode = await child.exited;
    if (captures === null) return { kind: "settled", exitCode, tails: null };
    const tails = { stdout: await captures.stdout.done, stderr: await captures.stderr.done };
    return { kind: "settled", exitCode, tails };
  })();

  const outcome = await Promise.race([settled, deadline]);
  clearTimeout(timer);
  if (outcome.kind === "deadline") {
    // The losing promise may never settle now: attach the catch so a stream error on the
    // way out is not reported as an unhandled rejection.
    void settled.catch(() => {});
    captures?.stdout.detach();
    captures?.stderr.detach();
  }
  return outcome;
}

/**
 * Replays a quiet run. A green run prints only bun's pass/fail block; a failed or
 * timed-out run prints both bounded tails, never any other child output.
 */
function replay(tails: Tails | null, run: { failed: boolean; out: Write; err: Write }): void {
  if (tails === null) return;
  if (!run.failed) {
    const summary = extractTestSummary(tails.stderr.text) || extractTestSummary(tails.stdout.text);
    if (summary !== "") run.out(summary);
    return;
  }
  if (tails.stdout.text !== "") run.out(tails.stdout.text);
  if (tails.stderr.text !== "") run.err(tails.stderr.text);
}

/**
 * The `bun test` arguments for the coverage run.
 *
 * `--parallel` / `--parallel=N` in this script's argv is forwarded to `bun test`
 * together with `--no-isolate`, the same pair the confined step uses
 * (nax-agent/scripts/lib/confined-run.ts). `--parallel` alone implies `--isolate`,
 * which re-imports every module per file: on CI's 4-core runner that made the nax
 * coverage run slower than serial (331s vs ~187s) and dropped a file below the
 * per-file floor. With `--no-isolate`, Bun still writes ONE merged
 * coverage/lcov.info; probed on Bun 1.4.4 against the nax suite, `--parallel=4
 * --no-isolate` reported the same 1,589 src/ files and line totals within 1 of a
 * serial run, in 54s against 162-176s. Bun 1.4.3 merges parallel coverage wrongly
 * (src/execution/batching.ts came out 35/107 lines against 65/65 serial), so this
 * needs Bun 1.4.4 or later.
 */
export function coverageTestArgs(paths: readonly string[], argv: readonly string[]): string[] {
  const parallel = argv.filter((arg) => arg === "--parallel" || arg.startsWith("--parallel="));
  for (const flag of parallel) {
    const value = flag.slice("--parallel=".length);
    if (flag !== "--parallel" && !/^[1-9]\d*$/.test(value)) {
      throw new Error(`[coverage] ${flag}: the worker count must be a positive integer`);
    }
  }
  return [
    "test",
    ...paths,
    "--coverage",
    "--coverage-reporter=lcov",
    ...(parallel.length > 0 ? [parallel[parallel.length - 1], "--no-isolate"] : []),
    // Same per-test budget as the CI suite steps (`bun test <dir>
    // --timeout=60000`). Coverage instrumentation adds enough overhead that
    // the 5s default fails process-timing tests that pass uninstrumented —
    // e.g. "runArgv > kills an overrunning process" took 5000.95ms in CI.
    // The whole run is still bounded by RUN_TIMEOUT_MS.
    "--timeout=60000",
  ];
}

/**
 * The `bun test … --coverage` command for this package's gated suites, or null (after
 * explaining) when the package has none.
 */
function gatedCommand(argv: readonly string[]): string[] | null {
  const suites = gatedSuites(ROOT);
  if (suites.length === 0) {
    console.error(`[coverage] no test/unit, test/integration or test/ui directory under ${ROOT}`);
    return null;
  }
  // Opt-in (nax): drop unit/integration files that never reference src/ (coverage-test-selection.ts).
  const selection = argv.includes("--skip-source-free-tests")
    ? coverageTestPaths(ROOT, suites)
    : { paths: suites, skipped: [] };
  if (selection.skipped.length > 0)
    console.log(
      `[coverage] skipping ${selection.skipped.length} test file(s) that never reference src/ (they record no coverage; CI's confined step still runs them)`,
    );
  return ["bun", ...coverageTestArgs(selection.paths, argv)];
}

/**
 * Run the gated suites with coverage in a detached process group so a hang or
 * SIGABRT is reaped along with any descendants (mirrors scripts/run-tests.ts).
 *
 * All three directories go to ONE invocation: Bun writes a single merged
 * coverage/lcov.info per invocation and cannot merge across invocations, so
 * splitting them into phases the way run-tests.ts does would lose the merge.
 *
 * Only the lcov reporter is requested. The `text` reporter used to abort the whole
 * run with `error: An internal error occurred (WriteFailed)` whenever stdout was a
 * pipe rather than a TTY — every CI context, and any local `| head`/`| tail`. That
 * is fixed as of Bun 1.4.0 (re-probed 2026-08-30: `coverageReporter = ["text",
 * "lcov"]` piped to `tail` prints the full table and exits 0), so enabling it is
 * now an option; it stays off because its ~800-row table is cosmetic here — the
 * floors are evaluated by parsing coverage/lcov.info and the summary below prints
 * the numbers that matter.
 *
 * Note the flag in coverageTestArgs is belt-and-braces only: bunfig.toml's
 * `coverageReporter` wins over `--coverage-reporter` on the command line, so this
 * argument does not actually select the reporter.
 */
export async function runCoverage(options: RunCoverageOptions = {}): Promise<number> {
  // Mirrors scripts/run-tests.ts: under AGENT=1 a green run stays quiet (just bun's
  // summary block) and the captured output is replayed only when the run fails.
  const quiet = options.quiet ?? process.env.AGENT === "1";
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const err = options.err ?? ((text: string) => process.stderr.write(text));
  const command = options.command ?? gatedCommand(process.argv);
  if (command === null) return 1;
  const child = _coverageDeps.spawn([...command], {
    cwd: ROOT,
    env: { ...process.env, AGENT: "1" },
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
    // Leader of its own process group so the deadline kill reaches descendants.
    detached: true,
  });

  // Drain BOTH pipes from launch, not from exit: a child that fills a pipe blocks until
  // something reads it, so starting the drain after `exited` deadlocks at the pipe buffer.
  const captures = quiet ? { stdout: captureStream(child.stdout), stderr: captureStream(child.stderr) } : null;

  const outcome = await settleUnderDeadline(child, captures, timeoutMs);
  if (outcome.kind === "deadline") {
    // The exit status is unknown and EOF may never arrive, so the deadline decides: replay
    // what the bounded captures hold and abandon the rest rather than block past the budget.
    const tails = captures === null ? null : { stdout: captures.stdout.snapshot(), stderr: captures.stderr.snapshot() };
    replay(tails, { failed: true, out, err });
    err(`\n[coverage] unit suite exceeded ${timeoutMs / 1000}s — killed.`);
    return 124;
  }
  if (captures !== null) replay(outcome.tails, { failed: outcome.exitCode !== 0, out, err });
  return outcome.exitCode;
}

/**
 * Sums the aggregate line/function totals, counting only records under
 * `SCOPE_PREFIXES`. Records outside them (test helpers, preload) are skipped.
 */
export function parseLcov(text: string, scopePrefixes: string | readonly string[] = SCOPE_PREFIXES): Totals {
  const totals: Totals = { linesFound: 0, linesHit: 0, fnFound: 0, fnHit: 0 };
  let included = false;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const tag = line.slice(0, colon);
    if (tag === "SF") {
      included = inScope(line.slice(colon + 1), scopePrefixes);
      continue;
    }
    if (!included) continue;
    const value = Number.parseInt(line.slice(colon + 1), 10);
    if (Number.isNaN(value)) continue;
    switch (tag) {
      case "LF":
        totals.linesFound += value;
        break;
      case "LH":
        totals.linesHit += value;
        break;
      case "FNF":
        totals.fnFound += value;
        break;
      case "FNH":
        totals.fnHit += value;
        break;
    }
  }
  return totals;
}

function pct(hit: number, found: number): number {
  return found === 0 ? 1 : hit / found;
}

const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;

/**
 * The aggregate floor's failures. A report with no `src/` lines at all fails on its
 * own: `pct` reads 0/0 as 100%, so an empty or mis-scoped lcov (wrong cwd, paths that
 * no longer start with `src/`) would otherwise pass every floor.
 */
export function aggregateFailures(totals: Totals): string[] {
  if (totals.linesFound === 0) return ["the report measured no src/ lines (empty or mis-scoped lcov)"];
  const lines = pct(totals.linesHit, totals.linesFound);
  const functions = pct(totals.fnHit, totals.fnFound);
  const failures: string[] = [];
  if (lines < FLOOR.lines) failures.push(`line coverage ${fmtPct(lines)} < floor ${fmtPct(FLOOR.lines)}`);
  if (functions < FLOOR.functions)
    failures.push(`function coverage ${fmtPct(functions)} < floor ${fmtPct(FLOOR.functions)}`);
  return failures;
}

export interface PerFileBaseline {
  updatedAt: string;
  /** Map of relative path -> recorded line coverage ratio (0-1) for every grandfathered file. */
  byFile: Record<string, number>;
}

/** Parses per-file `SF:`/`LF:`/`LH:` records from an lcov report, scoped to PER_FILE_SCOPE_PREFIXES. */
export function parsePerFileLines(text: string): Map<string, number> {
  const result = new Map<string, number>();
  let file: string | null = null;
  let lf = 0;
  let lh = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      file = line.slice(3);
      lf = 0;
      lh = 0;
    } else if (line.startsWith("LF:")) {
      lf = Number.parseInt(line.slice(3), 10) || 0;
    } else if (line.startsWith("LH:")) {
      lh = Number.parseInt(line.slice(3), 10) || 0;
    } else if (line.startsWith("end_of_record")) {
      if (file !== null && inScope(file, PER_FILE_SCOPE_PREFIXES)) result.set(file, pct(lh, lf));
      file = null;
    }
  }
  return result;
}

/** A baselined file that the report did not mention at all. */
export interface MissingBaselined {
  file: string;
  /** The coverage ratio the baseline recorded for it, before it vanished. */
  recorded: number;
}

/**
 * Baselined files with no `SF:` record in the report that are still present on disk.
 *
 * `exists` and `unmeasurable` are injected so this is a pure function over its inputs.
 * Files in `unmeasurable` are excluded — reported separately rather than failing the run.
 */
export function findMissingBaselined(
  baseline: Record<string, number>,
  perFile: Map<string, number>,
  exists: (file: string) => boolean,
  unmeasurable: Record<string, string> = UNMEASURABLE,
): MissingBaselined[] {
  return Object.entries(baseline)
    .filter(([file]) => !perFile.has(file) && !(file in unmeasurable) && exists(file))
    .map(([file, recorded]) => ({ file, recorded }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** One transpiler per loader: `tsx` rejects valid `.ts` syntax such as `<T>(x: T) => x`. */
const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
} as const;

/** What is left of transpiled output that Bun does not record as executable. */
const NON_EXECUTABLE: readonly RegExp[] = [
  /\/\*[\s\S]*?\*\//g,
  /\/\/[^\n]*/g,
  /^\s*import\s[^;\n]*;?\s*$/gm,
  /^\s*export\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"']+["'];?\s*$/gm,
  /^\s*export\s*\{\s*\}\s*;?\s*$/gm,
];

/**
 * Whether a source file has anything Bun would record a line for. Bun writes no
 * `SF:` record for a file of types or re-exports only, so such a file's absence
 * from the report is expected, not a measurement hole.
 */
export function hasExecutableCode(source: string, path = "file.ts"): boolean {
  const transpiler = path.endsWith(".tsx") ? TRANSPILERS.tsx : TRANSPILERS.ts;
  let js: string;
  try {
    js = transpiler.transformSync(source);
  } catch {
    // Source that does not transpile is never exempt: report it rather than crash the gate.
    return true;
  }
  return NON_EXECUTABLE.reduce((text, re) => text.replace(re, ""), js).trim() !== "";
}

/**
 * `src/` files on disk that hold executable code but have no record in the report
 * (spec S2 §7.2). The ratchet alone cannot see them: a file the report never names
 * is neither below the floor nor baselined, so it would pass at 0%.
 */
export function findUnreportedFiles(
  onDisk: readonly string[],
  perFile: ReadonlyMap<string, number>,
  hasCode: (file: string) => boolean,
  unmeasurable: Record<string, string> = UNMEASURABLE,
): string[] {
  return onDisk
    .filter((file) => !perFile.has(file) && !(file in unmeasurable) && hasCode(file))
    .sort((a, b) => a.localeCompare(b));
}

/** Every `.ts`/`.tsx` source under `<root>/src/`, as the report names them (`src/...`). */
export function sourceFiles(root: string): string[] {
  return [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root })].filter((f) => !f.endsWith(".d.ts"));
}

/**
 * The baseline `--update-baseline` should write: every below-floor file in the report,
 * plus any previously-baselined file that the report omitted while it still exists on
 * disk, carried forward at its recorded number.
 *
 * Carrying forward is what stops a vanished file from being silently dropped (#1779).
 * An entry is only removed when the report actually shows the file at or above the floor,
 * or when the file is gone from disk.
 */
export function buildUpdatedBaseline(
  previous: Record<string, number>,
  perFile: Map<string, number>,
  exists: (file: string) => boolean,
): { byFile: Record<string, number>; carried: string[] } {
  const byFile: Record<string, number> = Object.fromEntries(
    [...perFile.entries()].filter(([, p]) => p < PER_FILE_FLOOR),
  );
  const carried: string[] = [];
  for (const [file, recorded] of Object.entries(previous)) {
    if (perFile.has(file) || !exists(file)) continue;
    byFile[file] = recorded;
    carried.push(file);
  }
  return { byFile, carried: carried.sort((a, b) => a.localeCompare(b)) };
}

/** Whether a repo-relative path still exists in the working tree. */
function onDisk(file: string): boolean {
  return existsSync(join(ROOT, file));
}

function loadPerFileBaseline(): PerFileBaseline | null {
  try {
    return JSON.parse(readFileSync(PER_FILE_BASELINE_FILE, "utf8")) as PerFileBaseline;
  } catch {
    return null;
  }
}

function savePerFileBaseline(byFile: Record<string, number>) {
  mkdirSync(dirname(PER_FILE_BASELINE_FILE), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(byFile)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, p]) => [f, Math.round(p * 10_000) / 10_000]),
  );
  writeFileSync(
    PER_FILE_BASELINE_FILE,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), byFile: sorted }, null, 2)}\n`,
  );
}

/**
 * Process and baseline I/O seams, so evaluation tests exercise the ratchet and the
 * capture path without editing package baselines or launching the real suite.
 */
export const _coverageDeps = {
  loadPerFileBaseline,
  spawn(command: string[], options: SpawnOptions): Bun.Subprocess {
    return Bun.spawn(command, options);
  },
};

/** Evaluates the per-file ratchet. Returns false and prints details if it should fail the run. */
function checkPerFile(perFile: Map<string, number>, opts: { list: boolean }): boolean {
  const belowFloor = [...perFile.entries()].filter(([, p]) => p < PER_FILE_FLOOR).sort(([, a], [, b]) => a - b);

  if (opts.list) {
    for (const [file, p] of belowFloor) console.log(`${file}  ${(p * 100).toFixed(2)}%`);
    console.log(`\nTotal below ${(PER_FILE_FLOOR * 100).toFixed(0)}% floor: ${belowFloor.length}`);
    const listBaseline = loadPerFileBaseline();
    if (listBaseline) {
      const missing = findMissingBaselined(listBaseline.byFile, perFile, onDisk);
      for (const m of missing)
        console.log(`${m.file}  MISSING from report (baseline ${(m.recorded * 100).toFixed(2)}%)`);
      console.log(`Baselined files missing from the report: ${missing.length}`);
    }
    return true;
  }

  const baseline = _coverageDeps.loadPerFileBaseline();
  if (!baseline) {
    console.error(`\n[coverage] ERROR: ${PER_FILE_BASELINE_FILE} missing.`);
    console.error(
      `Currently below the ${(PER_FILE_FLOOR * 100).toFixed(0)}% per-file floor: ${belowFloor.length} files.`,
    );
    console.error("Run 'bun run test:coverage:update' to initialize.");
    return false;
  }

  const missing = findMissingBaselined(baseline.byFile, perFile, onDisk);
  const newViolations: string[] = [];
  const grown: string[] = [];
  for (const [file, p] of belowFloor) {
    const recorded = baseline.byFile[file];
    if (recorded === undefined) {
      newViolations.push(`  ${file}: ${(p * 100).toFixed(2)}% (floor ${(PER_FILE_FLOOR * 100).toFixed(0)}%)`);
    } else if (p < recorded - PER_FILE_EPSILON) {
      grown.push(`  ${file}: ${(p * 100).toFixed(2)}% (was ${(recorded * 100).toFixed(2)}%)`);
    }
  }

  console.log(
    `\n── per-file coverage ratchet (${PER_FILE_SCOPE_PREFIXES.join(", ")}) ──\n  ${belowFloor.length} files below floor (baseline ${Object.keys(baseline.byFile).length}).`,
  );

  if (newViolations.length === 0 && grown.length === 0 && missing.length === 0) {
    const raisable = Object.keys(baseline.byFile).some((f) => {
      const current = perFile.get(f);
      return current !== undefined && current >= PER_FILE_FLOOR;
    });
    if (raisable)
      console.log("  Some baselined files now meet the floor — baseline can be lowered with --update-baseline.");
    return true;
  }

  console.error("\n[coverage] FAIL — per-file coverage ratchet breached.");
  if (missing.length > 0) {
    console.error("\nBaselined files with NO record in the report, though they still exist on disk.");
    console.error("A file can be executed by a passing test and still be omitted (GitHub #1779);");
    console.error("treating that as a pass would let the entry be deleted as if it had graduated.");
    for (const m of missing) console.error(`  ${m.file} (baseline ${(m.recorded * 100).toFixed(2)}%)`);
    console.error("\nRun the file's own test alone with --coverage to confirm it records in isolation,");
    console.error("then add it to UNMEASURABLE in this script with the reason and a linked issue.");
  }
  if (newViolations.length > 0) {
    console.error(`\nNew files below the ${(PER_FILE_FLOOR * 100).toFixed(0)}% floor — add tests before merging:`);
    for (const v of newViolations) console.error(v);
  }
  if (grown.length > 0) {
    console.error("\nGrandfathered files whose coverage DROPPED below their recorded baseline:");
    for (const v of grown) console.error(v);
  }
  console.error("\nIf a file's coverage genuinely improved, lower its baseline with:");
  console.error("  bun run test:coverage:update");
  return false;
}

/** Prints the unreported files for --list / --report. */
function printUnreported(unreported: readonly string[]): void {
  for (const file of unreported) console.log(`${file}  NOT IN REPORT`);
}

/** CI mode: an unreported file with code fails the run. Returns false (and explains) when it should. */
function checkUnreported(unreported: readonly string[]): boolean {
  if (unreported.length === 0) return true;
  console.error(`\n[coverage] FAIL — ${unreported.length} src/ file(s) hold code but have no record in the report:`);
  for (const file of unreported) console.error(`  ${file}`);
  console.error("Each file holds code but no test loads it. Add a test that does, or, if a test does load it");
  console.error("and Bun still omits it (GitHub #1779), list it in UNMEASURABLE with the reason.");
  return false;
}

/** Evaluates all coverage checks; sandboxing changes only file-level enforcement. */
export function evaluateCoverageGate({
  totals,
  perFile,
  unreported,
  env,
  log,
  error,
}: {
  totals: Totals;
  perFile: Map<string, number>;
  unreported: readonly string[];
  env: CoverageEnvironment;
  log: (message: string) => void;
  error: (message: string) => void;
}): 0 | 1 {
  const failures = aggregateFailures(totals);
  const perFileOk = checkPerFile(perFile, { list: false });
  const allFilesOk = checkUnreported(unreported);
  return finishCoverage({ aggregateFailures: failures, perFileOk, allFilesOk, env, log, error });
}

/**
 * Seams for `main`: the runner (so a test can inject a short deadline and a fixture
 * command) and the two process-level side effects (exit status, diagnostics).
 */
export interface MainDeps {
  /** Coverage runner. Defaults to runCoverage. */
  run?: (options?: RunCoverageOptions) => Promise<number>;
  /** Options handed to the runner. Tests set the deadline and the fixture command here. */
  runOptions?: RunCoverageOptions;
  /** Exit seam. Defaults to process.exit, which a test must never reach. */
  exit?: (code: number) => void;
  /** Diagnostics seam. Defaults to console.error. */
  error?: (message: string) => void;
}

export async function main(deps: MainDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const error = deps.error ?? ((message: string) => console.error(message));
  const requireAllFiles = process.argv.includes("--require-all-files");
  const reportOnly = process.argv.includes("--report");
  const updateBaseline = process.argv.includes("--update-baseline");
  const list = process.argv.includes("--list");

  const runExit = await (deps.run ?? runCoverage)(deps.runOptions);
  if (runExit !== 0) {
    error(`\n[coverage] test run failed (exit ${runExit}) — not evaluating coverage.`);
    exit(1);
    return;
  }

  const lcovFile = Bun.file(LCOV_PATH);
  if (!(await lcovFile.exists())) {
    error(`\n[coverage] expected lcov report at ${LCOV_PATH} but none was produced.`);
    exit(1);
    return;
  }

  const lcovText = await lcovFile.text();
  const totals = parseLcov(lcovText);
  const lines = pct(totals.linesHit, totals.linesFound);
  const functions = pct(totals.fnHit, totals.fnFound);
  const perFile = parsePerFileLines(lcovText);
  const unreported = requireAllFiles
    ? findUnreportedFiles(sourceFiles(ROOT), perFile, (f) => hasExecutableCode(readFileSync(join(ROOT, f), "utf8"), f))
    : [];

  const fmt = (n: number) => `${(n * 100).toFixed(2)}%`;
  console.log(`\n── coverage gate (${gatedSuites(ROOT).join(", ")} → ${SCOPE_PREFIXES.join(", ")}) ──`);
  console.log(`  lines:     ${fmt(lines)}  (${totals.linesHit}/${totals.linesFound}, floor ${fmt(FLOOR.lines)})`);
  console.log(`  functions: ${fmt(functions)}  (${totals.fnHit}/${totals.fnFound}, floor ${fmt(FLOOR.functions)})`);
  if (requireAllFiles) console.log(`  unreported src/ files with code: ${unreported.length}`);

  if (list) {
    checkPerFile(perFile, { list: true });
    printUnreported(unreported);
    return;
  }

  if (updateBaseline) {
    const previous = loadPerFileBaseline()?.byFile ?? {};
    const { byFile, carried } = buildUpdatedBaseline(previous, perFile, onDisk);
    savePerFileBaseline(byFile);
    console.log(
      `\n[coverage] per-file baseline updated: ${Object.keys(byFile).length} files below the ${(PER_FILE_FLOOR * 100).toFixed(0)}% floor.`,
    );
    if (carried.length > 0) {
      console.log(
        `[coverage] ${carried.length} entr${carried.length === 1 ? "y" : "ies"} carried forward — the file exists but the report omitted it (GitHub #1779), so its number is kept rather than dropped:`,
      );
      for (const f of carried) console.log(`  ${f}`);
    }
    return;
  }

  if (reportOnly) {
    checkPerFile(perFile, { list: false });
    printUnreported(unreported);
    return;
  }

  exit(evaluateCoverageGate({ totals, perFile, unreported, env: process.env, log: console.log, error }));
}

if (import.meta.main) await main();
