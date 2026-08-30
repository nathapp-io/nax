#!/usr/bin/env bun
/**
 * Coverage gate: runs the unit suite with coverage, parses coverage/lcov.info,
 * and fails if overall line or function coverage drops below the floor.
 *
 * Why a custom script: Bun 1.3.x collects coverage and accepts a
 * `coverageThreshold` in bunfig.toml, but does NOT enforce it via exit code
 * (verified: 33% coverage vs a 0.99 threshold still exits 0). So the floor is
 * enforced here by parsing the lcov report.
 *
 * Scope: the unit suite (`test/unit/`) — the bulk of the tests, fast (~20s) and
 * reliable. Integration/UI/e2e are excluded because Bun cannot merge coverage
 * across the separate process-group invocations the wrapper uses, and they add
 * little source coverage over the unit suite.
 *
 * Per-file floor: the aggregate floor above can hide a single file collapsing
 * (e.g. 12% -> 0%) inside an 87%-covered repo. A second ratchet, in the same
 * style as check-file-sizes.ts / check-nax-error.ts, tracks every `src/`
 * file whose unit-suite line coverage sits below PER_FILE_FLOOR. Files already
 * below it are grandfathered in scripts/baselines/coverage-per-file-baseline.json
 * at their current pct; the gate then fails if a NEW file drops below the floor,
 * or a grandfathered file's coverage falls further below its recorded baseline.
 * It does not require the aggregate-excluded suites (integration/UI/e2e) to be
 * merged in — it is deliberately blind to coverage those suites alone provide,
 * same caveat as the aggregate floor.
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
 *   bun scripts/check-coverage.ts                   # run + enforce floors (CI mode)
 *   bun scripts/check-coverage.ts --report          # run + print summary, never fail
 *   bun scripts/check-coverage.ts --update-baseline # run + save new per-file baseline
 *   bun scripts/check-coverage.ts --list            # run + print all below-floor files
 *
 * Exit codes:
 *   0 — coverage at/above floor (or --report / --update-baseline / --list)
 *   1 — below a floor, the test run failed, or lcov.info was not produced
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LCOV_PATH = join(ROOT, "coverage", "lcov.info");
const PER_FILE_BASELINE_FILE = join(import.meta.dir, "baselines", "coverage-per-file-baseline.json");

/** Enforced floor. Matches the documented 80% rule (.claude/rules/common/testing.md). */
const FLOOR = { lines: 0.8, functions: 0.8 };

/** Per-file floor and scope for the second ratchet described above. */
const PER_FILE_FLOOR = 0.8;
const PER_FILE_SCOPE_PREFIX = "src/";
/** Baseline comparisons ignore drift below this to absorb run-to-run rounding noise. */
const PER_FILE_EPSILON = 0.001;

/**
 * Files known to be absent from the report despite being executed by a passing test,
 * with the reason. Listed here so the missing-file guard reports them without failing
 * the run — every other absence is a new instance of #1779 and must fail.
 *
 * Keep this map empty if you can. An entry is a measurement hole, not an exemption from
 * the floor: the file's recorded baseline number is still carried forward and still
 * ratcheted the moment the report starts including it again.
 */
export const UNMEASURABLE: Record<string, string> = {
  "src/prompts/loader.ts":
    "GitHub #1779 — its 16 tests pass and the module is imported for value, but Bun emits no SF: record for it whenever the run also contains test/unit/execution/mutation-check-wiring.test.ts. Deterministic; not a race, not `smol`, not a file-count threshold.",
};

/** Wall-clock cap for the coverage run, in ms. */
const RUN_TIMEOUT_MS = 300_000;

export interface Totals {
  linesFound: number;
  linesHit: number;
  fnFound: number;
  fnHit: number;
}

/**
 * Run the unit suite with coverage in a detached process group so a hang or
 * SIGABRT is reaped along with any descendants (mirrors scripts/run-tests.ts).
 *
 * Only the lcov reporter is requested. `--coverage-reporter=text` aborts the
 * whole run with `error: An internal error occurred (WriteFailed)` whenever
 * stdout is a pipe rather than a TTY — which is every CI context, and any local
 * `| head`/`| tail`. That is why this gate could never have run in CI. The
 * per-file table it printed was cosmetic: the floor is evaluated by parsing
 * coverage/lcov.info, and the summary below prints the numbers that matter.
 */
async function runCoverage(): Promise<number> {
  const child = Bun.spawn(
    [
      "bun",
      "test",
      "test/unit/",
      "--coverage",
      "--coverage-reporter=lcov",
      // Same per-test budget as the CI unit step (`bun test test/unit/
      // --timeout=60000`). Coverage instrumentation adds enough overhead that
      // the 5s default fails process-timing tests that pass uninstrumented —
      // e.g. "runArgv > kills an overrunning process" took 5000.95ms in CI.
      // The whole run is still bounded by RUN_TIMEOUT_MS.
      "--timeout=60000",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, AGENT: "1" },
      stdout: "inherit",
      stderr: "inherit",
      // Leader of its own process group so the timeout kill reaches descendants.
      detached: true,
    },
  );

  const pgid = child.pid;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, RUN_TIMEOUT_MS);

  const exitCode = await child.exited;
  clearTimeout(timer);

  if (timedOut) {
    console.error(`\n[coverage] unit suite exceeded ${RUN_TIMEOUT_MS / 1000}s — killed.`);
    return 124;
  }
  return exitCode;
}

export function parseLcov(text: string): Totals {
  const totals: Totals = { linesFound: 0, linesHit: 0, fnFound: 0, fnHit: 0 };
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const tag = line.slice(0, colon);
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

export interface PerFileBaseline {
  updatedAt: string;
  /** Map of relative path -> recorded line coverage ratio (0-1) for every grandfathered file. */
  byFile: Record<string, number>;
}

/** Parses per-file `SF:`/`LF:`/`LH:` records from an lcov report, scoped to PER_FILE_SCOPE_PREFIX. */
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
      if (file?.startsWith(PER_FILE_SCOPE_PREFIX)) result.set(file, pct(lh, lf));
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

  const baseline = loadPerFileBaseline();
  if (!baseline) {
    console.error(`\n[coverage] ERROR: ${PER_FILE_BASELINE_FILE} missing.`);
    console.error(
      `Currently below the ${(PER_FILE_FLOOR * 100).toFixed(0)}% per-file floor: ${belowFloor.length} files.`,
    );
    console.error("Run 'bun scripts/check-coverage.ts --update-baseline' to initialize.");
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
    `\n── per-file coverage ratchet (${PER_FILE_SCOPE_PREFIX}) ──\n  ${belowFloor.length} files below floor (baseline ${Object.keys(baseline.byFile).length}).`,
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
  console.error("  bun scripts/check-coverage.ts --update-baseline");
  return false;
}

async function main() {
  const reportOnly = process.argv.includes("--report");
  const updateBaseline = process.argv.includes("--update-baseline");
  const list = process.argv.includes("--list");

  const runExit = await runCoverage();
  if (runExit !== 0) {
    console.error(`\n[coverage] test run failed (exit ${runExit}) — not evaluating coverage.`);
    process.exit(1);
  }

  const lcovFile = Bun.file(LCOV_PATH);
  if (!(await lcovFile.exists())) {
    console.error(`\n[coverage] expected lcov report at ${LCOV_PATH} but none was produced.`);
    process.exit(1);
  }

  const lcovText = await lcovFile.text();
  const totals = parseLcov(lcovText);
  const lines = pct(totals.linesHit, totals.linesFound);
  const functions = pct(totals.fnHit, totals.fnFound);
  const perFile = parsePerFileLines(lcovText);

  const fmt = (n: number) => `${(n * 100).toFixed(2)}%`;
  console.log("\n── coverage gate (test/unit) ──");
  console.log(`  lines:     ${fmt(lines)}  (${totals.linesHit}/${totals.linesFound}, floor ${fmt(FLOOR.lines)})`);
  console.log(`  functions: ${fmt(functions)}  (${totals.fnHit}/${totals.fnFound}, floor ${fmt(FLOOR.functions)})`);

  if (list) {
    checkPerFile(perFile, { list: true });
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
    return;
  }

  const failures: string[] = [];
  if (lines < FLOOR.lines) failures.push(`line coverage ${fmt(lines)} < floor ${fmt(FLOOR.lines)}`);
  if (functions < FLOOR.functions) failures.push(`function coverage ${fmt(functions)} < floor ${fmt(FLOOR.functions)}`);

  const perFileOk = checkPerFile(perFile, { list: false });

  if (failures.length > 0) {
    console.error(`\n[coverage] FAIL — ${failures.join("; ")}`);
    console.error("Add tests for the uncovered code (see the per-file report above), or");
    console.error("if the floor is genuinely too high, adjust FLOOR in scripts/check-coverage.ts.");
    process.exit(1);
  }

  if (!perFileOk) process.exit(1);

  console.log("\n[coverage] OK — at or above floor.");
}

if (import.meta.main) await main();
