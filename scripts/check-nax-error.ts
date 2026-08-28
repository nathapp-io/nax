#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * Ratchet check: prevents new `throw new Error(...)` from being added to src/.
 * All errors must use NaxError per .claude/rules/error-handling.md.
 *
 * On first run, use --update-baseline to record the current violation count.
 * On every subsequent run, fails if the count has INCREASED.
 * The baseline shrinks as files are migrated — delete it once it reaches 0.
 *
 * Usage:
 *   bun scripts/check-nax-error.ts                   # check (CI mode)
 *   bun scripts/check-nax-error.ts --update-baseline # save new baseline
 *   bun scripts/check-nax-error.ts --list            # print all violations
 *
 * Allow-list a single line by appending `// nax-lint-allow: plain-error`.
 *
 * Exit codes:
 *   0 — no new violations (count <= baseline)
 *   1 — ratchet breached or baseline missing
 */
import { Glob } from "bun";
import { byCodePoint } from "../src/utils/sort";

const ROOT = join(import.meta.dir, "..");
const BASELINE_FILE = join(import.meta.dir, "baselines", "nax-error-baseline.json");
const SCAN_DIR = "src";
const ALLOW_MARKER = "nax-lint-allow: plain-error";
const PATTERN = "throw new Error(";

interface Baseline {
  count: number;
  updatedAt: string;
  byFile?: Record<string, number>;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

async function scan(): Promise<Violation[]> {
  const out: Violation[] = [];
  const glob = new Glob("**/*.ts");
  for await (const file of glob.scan({ cwd: join(ROOT, SCAN_DIR), absolute: false })) {
    if (file.endsWith(".d.ts")) continue;
    const rel = join(SCAN_DIR, file);
    const text = await Bun.file(join(ROOT, rel)).text();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(PATTERN)) continue;
      if (line.includes(ALLOW_MARKER)) continue;
      out.push({ file: rel, line: i + 1, snippet: line.trim() });
    }
  }
  return out;
}

function tally(violations: Violation[]): Record<string, number> {
  const byFile: Record<string, number> = {};
  for (const v of violations) byFile[v.file] = (byFile[v.file] ?? 0) + 1;
  return byFile;
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(count: number, byFile: Record<string, number>) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ count, updatedAt: new Date().toISOString(), byFile }, null, 2)}\n`);
}

function diffByFile(current: Record<string, number>, baseline: Record<string, number>): string[] {
  const offenders: string[] = [];
  for (const file of Object.keys(current)) {
    if ((current[file] ?? 0) > (baseline[file] ?? 0)) offenders.push(file);
  }
  return offenders.sort(byCodePoint);
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update-baseline");
  const list = args.includes("--list");

  const violations = await scan();
  const byFile = tally(violations);
  const count = violations.length;

  if (list) {
    for (const v of violations) console.log(`${v.file}:${v.line}  ${v.snippet}`);
    console.log(`\nTotal: ${count}`);
    return;
  }

  if (update) {
    saveBaseline(count, byFile);
    console.log(`OK: baseline updated to ${count} violations.`);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error("ERROR: nax-error-baseline.json missing.");
    console.error(`Current violations: ${count}.`);
    console.error("Run 'bun scripts/check-nax-error.ts --update-baseline' to initialize.");
    process.exit(1);
  }

  if (count <= baseline.count) {
    console.log(`OK: ${count} violations (baseline ${baseline.count}).`);
    if (count < baseline.count) {
      console.log("Baseline can be lowered with --update-baseline.");
    }
    return;
  }

  const offenders = diffByFile(byFile, baseline.byFile ?? {});
  console.error(`ERROR: ${count} 'throw new Error(' calls in src/ (baseline ${baseline.count}).`);
  console.error("New or increased violations in these files:");
  for (const f of offenders) {
    console.error(`  ${f}  (was ${baseline.byFile?.[f] ?? 0}, now ${byFile[f]})`);
    // Emit per-line `file:line: message` so the text-block lint parser can
    // surface each call site as a structured finding to autofix.
    for (const v of violations.filter((x) => x.file === f)) {
      console.error(`  ${v.file}:${v.line}: plain Error throw — use NaxError`);
      console.error(`    ${v.snippet}`);
    }
  }
  console.error("\nUse NaxError instead — see .claude/rules/error-handling.md:");
  console.error("  throw new NaxError(msg, CODE, { stage, storyId, cause });");
  console.error("\nIf genuinely unavoidable, append '// nax-lint-allow: plain-error'.");
  process.exit(1);
}

await main();
