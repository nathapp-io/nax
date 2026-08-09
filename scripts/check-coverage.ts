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
 * Usage:
 *   bun scripts/check-coverage.ts            # run + enforce floor (CI mode)
 *   bun scripts/check-coverage.ts --report   # run + print summary, never fail
 *
 * Exit codes:
 *   0 — coverage at/above floor (or --report)
 *   1 — below floor, the test run failed, or lcov.info was not produced
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LCOV_PATH = join(ROOT, "coverage", "lcov.info");

/** Enforced floor. Matches the documented 80% rule (.claude/rules/common/testing.md). */
const FLOOR = { lines: 0.8, functions: 0.8 };

/** Wall-clock cap for the coverage run, in ms. */
const RUN_TIMEOUT_MS = 300_000;

interface Totals {
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
      "--timeout=5000",
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

function parseLcov(text: string): Totals {
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

async function main() {
  const reportOnly = process.argv.includes("--report");

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

  const totals = parseLcov(await lcovFile.text());
  const lines = pct(totals.linesHit, totals.linesFound);
  const functions = pct(totals.fnHit, totals.fnFound);

  const fmt = (n: number) => `${(n * 100).toFixed(2)}%`;
  console.log("\n── coverage gate (test/unit) ──");
  console.log(`  lines:     ${fmt(lines)}  (${totals.linesHit}/${totals.linesFound}, floor ${fmt(FLOOR.lines)})`);
  console.log(`  functions: ${fmt(functions)}  (${totals.fnHit}/${totals.fnFound}, floor ${fmt(FLOOR.functions)})`);

  if (reportOnly) return;

  const failures: string[] = [];
  if (lines < FLOOR.lines) failures.push(`line coverage ${fmt(lines)} < floor ${fmt(FLOOR.lines)}`);
  if (functions < FLOOR.functions)
    failures.push(`function coverage ${fmt(functions)} < floor ${fmt(FLOOR.functions)}`);

  if (failures.length > 0) {
    console.error(`\n[coverage] FAIL — ${failures.join("; ")}`);
    console.error("Add tests for the uncovered code (see the per-file report above), or");
    console.error("if the floor is genuinely too high, adjust FLOOR in scripts/check-coverage.ts.");
    process.exit(1);
  }

  console.log("\n[coverage] OK — at or above floor.");
}

await main();
