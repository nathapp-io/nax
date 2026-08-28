#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * Ratchet check: enforces the file-size hard limits from
 * .claude/rules/project-conventions.md — 600 lines for source files,
 * 800 lines for test files.
 *
 * Existing oversized files are grandfathered via a baseline so this can land
 * without a repo-wide split. The ratchet then guarantees:
 *   - No NEW file may exceed its limit.
 *   - No grandfathered file may GROW past its recorded size.
 * A grandfathered file that shrinks lets the baseline be lowered; once a file
 * drops to/under its limit it leaves the baseline entirely.
 *
 * Usage:
 *   bun scripts/check-file-sizes.ts                   # check (CI mode)
 *   bun scripts/check-file-sizes.ts --update-baseline # save new baseline
 *   bun scripts/check-file-sizes.ts --list            # print all oversized files
 *
 * Exit codes:
 *   0 — no new/grown violations
 *   1 — ratchet breached or baseline missing
 */
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const BASELINE_FILE = join(import.meta.dir, "baselines", "file-sizes-baseline.json");

const SRC_LIMIT = 600;
const TEST_LIMIT = 800;

interface Scope {
  scanDir: string;
  pattern: string;
  limit: number;
  /** Excludes a matched file from the test scope (so src globs don't double-count test dirs). */
  exclude?: (rel: string) => boolean;
}

const SCOPES: Scope[] = [
  { scanDir: "src", pattern: "**/*.ts", limit: SRC_LIMIT },
  { scanDir: "test", pattern: "**/*.test.ts", limit: TEST_LIMIT },
];

interface Baseline {
  updatedAt: string;
  /** Map of relative path -> recorded line count for every grandfathered oversized file. */
  byFile: Record<string, number>;
}

interface Oversized {
  file: string;
  lines: number;
  limit: number;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  // A trailing newline yields an empty final element; don't count it as a line.
  return text.endsWith("\n") ? n - 1 : n;
}

async function scan(): Promise<Oversized[]> {
  const out: Oversized[] = [];
  for (const scope of SCOPES) {
    const glob = new Glob(scope.pattern);
    for await (const file of glob.scan({ cwd: join(ROOT, scope.scanDir), absolute: false })) {
      if (file.endsWith(".d.ts")) continue;
      const rel = join(scope.scanDir, file);
      if (scope.exclude?.(rel)) continue;
      const text = await Bun.file(join(ROOT, rel)).text();
      const lines = countLines(text);
      if (lines > scope.limit) out.push({ file: rel, lines, limit: scope.limit });
    }
  }
  return out.sort((a, b) => b.lines - a.lines);
}

function tally(oversized: Oversized[]): Record<string, number> {
  const byFile: Record<string, number> = {};
  for (const o of oversized) byFile[o.file] = o.lines;
  return byFile;
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(byFile: Record<string, number>) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ updatedAt: new Date().toISOString(), byFile: sorted }, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update-baseline");
  const list = args.includes("--list");

  const oversized = await scan();
  const byFile = tally(oversized);
  const count = oversized.length;

  if (list) {
    for (const o of oversized) console.log(`${o.file}  ${o.lines} lines (limit ${o.limit})`);
    console.log(`\nTotal oversized: ${count}`);
    return;
  }

  if (update) {
    saveBaseline(byFile);
    console.log(`OK: baseline updated to ${count} grandfathered oversized files.`);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error("ERROR: file-sizes-baseline.json missing.");
    console.error(`Current oversized files: ${count}.`);
    console.error("Run 'bun scripts/check-file-sizes.ts --update-baseline' to initialize.");
    process.exit(1);
  }

  const newViolations: string[] = [];
  const grown: string[] = [];
  for (const o of oversized) {
    const recorded = baseline.byFile[o.file];
    if (recorded === undefined) newViolations.push(`  ${o.file}: ${o.lines} lines (limit ${o.limit})`);
    else if (o.lines > recorded) grown.push(`  ${o.file}: ${o.lines} lines (was ${recorded}, limit ${o.limit})`);
  }

  if (newViolations.length === 0 && grown.length === 0) {
    const shrunk = Object.keys(baseline.byFile).some((f) => (byFile[f] ?? 0) < (baseline.byFile[f] ?? 0));
    console.log(`OK: ${count} grandfathered oversized files (baseline ${Object.keys(baseline.byFile).length}).`);
    if (shrunk) console.log("Baseline can be lowered with --update-baseline.");
    return;
  }

  console.error("ERROR: file-size hard limit breached (see .claude/rules/project-conventions.md).");
  if (newViolations.length > 0) {
    console.error(`\nNew files over the limit (${SRC_LIMIT} src / ${TEST_LIMIT} test) — split before merging:`);
    for (const v of newViolations) console.error(v);
  }
  if (grown.length > 0) {
    console.error("\nGrandfathered files that GREW past their recorded size — do not add more code:");
    for (const v of grown) console.error(v);
  }
  console.error("\nSplit the file by concern. If a file shrank below its baseline, lower it with:");
  console.error("  bun scripts/check-file-sizes.ts --update-baseline");
  process.exit(1);
}

await main();
