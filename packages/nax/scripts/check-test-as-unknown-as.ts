#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * Ratchet check: prevents `as unknown as` casts from being added to test/.
 * Issue #1514 — required by the issue's plan: "The ratchet must also count
 * `as unknown as`, so the escape hatch cannot absorb the work."
 *
 * On first run, use --update-baseline to record the current count.
 * On every subsequent run, fails if the count has INCREASED.
 * The baseline shrinks as tests are refactored to use factory helpers.
 *
 * Usage:
 *   bun scripts/check-test-as-unknown-as.ts                   # check (CI mode)
 *   bun scripts/check-test-as-unknown-as.ts --update-baseline # save new baseline
 *   bun scripts/check-test-as-unknown-as.ts --list            # print occurrences
 *
 * Exit codes:
 *   0 — no new casts (count <= baseline)
 *   1 — ratchet breached (count > baseline) or baseline missing
 *
 * Allow-list an occurrence with `// test-ratchet-allow: as-unknown-as`, appended
 * to the line or placed on either neighbouring line (added only if a wave gets
 * stuck on legitimate uses).
 */
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const SCAN_DIR = "test";
const BASELINE_FILE = join(import.meta.dir, "baselines", "test-as-unknown-as-baseline.json");
/**
 * Global so a line carrying more than one cast counts as more than one. A
 * per-line count would let two cast lines be joined into one to lower the
 * number without removing a cast, and would drift whenever the formatter
 * reflows a long line.
 */
const PATTERN = /\bas\s+unknown\s+as\b/g;
const ALLOW_MARKER = "test-ratchet-allow: as-unknown-as";

/**
 * Test files for the ratchet scripts themselves contain the literal phrase
 * "as unknown as" inside fixture strings that verify the scanner finds
 * them. They are not real double-casts. Skip them so the ratchet doesn't
 * grade its own scaffolding.
 */
const EXEMPT_FILES = new Set<string>(["test/unit/scripts/check-test-as-unknown-as.test.ts"]);

interface Baseline {
  count: number;
  updatedAt: string;
  byFile?: Record<string, number>;
}

export interface RatchetOutcome {
  ok: boolean;
  message: string;
  newViolations: Array<{ file: string; baseline: number; current: number }>;
}

export async function scanAsUnknownAs(rootDir: string): Promise<{ count: number; byFile: Record<string, number> }> {
  const byFile: Record<string, number> = {};
  let count = 0;
  // `{ts,tsx}`, not `**/*.ts`: test/ui/ is six .tsx files, and while the glob
  // read only `.ts` they were invisible to every counter here. That hid six
  // real `as never` sites for the whole drain — the same "zero on the ratchet
  // was not zero on the rule" failure as the noNonNullAssertion undercount,
  // with a glob ceiling instead of a regex one.
  const glob = new Glob("**/*.{ts,tsx}");
  for await (const file of glob.scan({ cwd: join(rootDir, SCAN_DIR), absolute: false })) {
    if (file.endsWith(".d.ts")) continue;
    const rel = join(SCAN_DIR, file);
    if (EXEMPT_FILES.has(rel)) continue;
    const text = await Bun.file(join(rootDir, rel)).text();
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      // `String.match` with a /g/ pattern ignores lastIndex, so the shared
      // regex stays safe to reuse across lines.
      const matches = line.match(PATTERN);
      if (matches === null) continue;
      // The marker suppresses the whole line, however many casts it carries.
      // Either neighbouring line counts too: the formatter reflows long lines
      // and pushes a trailing comment onto its own line, which would otherwise
      // silently un-suppress a deliberately allowed cast.
      if (line.includes(ALLOW_MARKER) || lines[i - 1]?.includes(ALLOW_MARKER) || lines[i + 1]?.includes(ALLOW_MARKER)) {
        continue;
      }
      byFile[rel] = (byFile[rel] ?? 0) + matches.length;
      count += matches.length;
    }
  }
  return { count, byFile };
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
        `[FAIL] No baseline found. Run \`bun scripts/check-test-as-unknown-as.ts --update-baseline\` first.\n` +
        `Current: ${count} casts.`,
      newViolations: [],
    };
  }

  const delta = count - baseline.count;

  if (delta <= 0) {
    const improved = delta < 0 ? ` (↓ ${Math.abs(delta)} removed since last baseline)` : "";
    return {
      ok: true,
      message: `[OK] ${count} 'as unknown as' cast(s) in test/ (baseline: ${baseline.count})${improved}.`,
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
    `[FAIL] ${delta} new 'as unknown as' cast(s) (${count} total, baseline: ${baseline.count}).`,
    "New or increased casts in these files:",
    ...offenders.map((o) => `  ${o.file}  (was ${o.baseline}, now ${o.current})`),
    "",
    "Use factory helpers (test/helpers/) instead of casting.",
    "If a cast is genuinely safe, append `// test-ratchet-allow: as-unknown-as`.",
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

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update-baseline");
  const list = args.includes("--list");

  const current = await scanAsUnknownAs(ROOT);

  if (list) {
    const entries: Array<{ file: string; count: number }> = Object.entries(current.byFile)
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count);
    for (const e of entries) console.log(`${e.file}  ${e.count}`);
    console.log(`\nTotal: ${current.count} 'as unknown as' casts across ${entries.length} files.`);
    return;
  }

  if (update) {
    saveBaseline(current);
    console.log(`[OK] Baseline saved: ${current.count} casts across ${Object.keys(current.byFile).length} files.`);
    return;
  }

  const baseline = loadBaseline();
  const { ok, message } = formatReport(current, baseline);
  if (ok) {
    console.log(message);
    return;
  }
  console.error(message);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
