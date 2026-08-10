#!/usr/bin/env bun
/**
 * Ratchet check: prevents new TypeScript errors from being added to test/.
 * Issue #1514 Phase 3a.
 *
 * Counts `error TS\d+:` matches from `bun x tsc --project tsconfig.test.json --noEmit` output.
 *
 * Usage:
 *   bun scripts/check-test-typecheck.ts                   # check (CI mode)
 *   bun scripts/check-test-typecheck.ts --update-baseline # save new baseline
 *   bun scripts/check-test-typecheck.ts --list            # print all errors
 *
 * Exit codes:
 *   0 — no new errors (count <= baseline)
 *   1 — ratchet breached (count > baseline) or baseline missing
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TSC_PROJECT = "tsconfig.test.json";
const BASELINE_FILE = join(import.meta.dir, "baselines", "test-typecheck-baseline.json");

interface Baseline {
  count: number;
  updatedAt: string;
  byFile?: Record<string, number>;
}

export function parseTypecheckOutput(stdout: string): {
  count: number;
  byFile: Record<string, number>;
} {
  const lines = stdout.split("\n");
  const byFile: Record<string, number> = {};
  let count = 0;
  // Pattern: `path/to/file.ts(line,col): error TS\d+: message`
  const re = /^([^(]+)\(\d+,\d+\):\s+error TS\d+:/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const file = m[1]?.trim();
    if (!file) continue;
    byFile[file] = (byFile[file] ?? 0) + 1;
    count++;
  }
  return { count, byFile };
}

export interface RatchetOutcome {
  ok: boolean;
  message: string;
  newViolations: Array<{ file: string; baseline: number; current: number }>;
}

export function formatReport(
  current: { count: number; byFile: Record<string, number> },
  baseline: Baseline | null,
): RatchetOutcome {
  const { count, byFile } = current;

  if (baseline === null) {
    return {
      ok: false,
      message:
        `[FAIL] No baseline found. Run \`bun scripts/check-test-typecheck.ts --update-baseline\` first.\n` +
        `Current: ${count} errors.`,
      newViolations: [],
    };
  }

  const delta = count - baseline.count;

  if (delta <= 0) {
    const improved = delta < 0 ? ` (↓ ${Math.abs(delta)} fixed since last baseline)` : "";
    return {
      ok: true,
      message: `[OK] ${count} typecheck error(s) in test/ (baseline ${baseline.count})${improved}.`,
      newViolations: [],
    };
  }

  const offenders: Array<{ file: string; baseline: number; current: number }> = [];
  for (const file of Object.keys(byFile)) {
    const currentN = byFile[file] ?? 0;
    const baseN = baseline.byFile?.[file] ?? 0;
    if (currentN > baseN) offenders.push({ file, baseline: baseN, current: currentN });
  }
  offenders.sort((a, b) => b.current - a.current);

  const lines = [
    `[FAIL] ${delta} new typecheck error(s) (${count} total, baseline ${baseline.count}).`,
    "New or increased errors in these files:",
    ...offenders.map((o) => `  ${o.file}  (was ${o.baseline}, now ${o.current})`),
    "",
    "Add the missing fields to factory helpers, or fix the test directly.",
    "Run `bun scripts/check-test-typecheck.ts --list` for full details.",
  ];
  return { ok: false, message: lines.join("\n"), newViolations: offenders };
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(current: { count: number; byFile: Record<string, number> }) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      { count: current.count, updatedAt: new Date().toISOString(), byFile: current.byFile },
      null,
      2,
    )}\n`,
  );
}

async function spawnTsc(): Promise<string> {
  const proc = Bun.spawn(["bun", "x", "tsc", "--project", TSC_PROJECT, "--noEmit"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return stdout + stderr;
}

function printList(stdout: string) {
  const errors = stdout
    .split("\n")
    .filter((l) => /error TS\d+/.test(l))
    .slice(0, 50);
  for (const e of errors) console.log(e);
  const total = parseTypecheckOutput(stdout).count;
  console.log(`\nTotal: ${total} (showing first ${errors.length})`);
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update-baseline");
  const list = args.includes("--list");

  if (!update && !list) {
    const stdout = await spawnTsc();
    const current = parseTypecheckOutput(stdout);
    const baseline = loadBaseline();
    const { ok, message } = formatReport(current, baseline);
    if (ok) {
      console.log(message);
      return;
    }
    console.error(message);
    process.exit(1);
  }

  const stdout = await spawnTsc();
  const current = parseTypecheckOutput(stdout);

  if (list) {
    printList(stdout);
    return;
  }

  if (update) {
    saveBaseline(current);
    console.log(
      `[OK] Baseline saved: ${current.count} errors across ${Object.keys(current.byFile).length} files.`,
    );
    return;
  }
}

if (import.meta.main) {
  await main();
}
