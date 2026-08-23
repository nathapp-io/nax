#!/usr/bin/env bun
/**
 * Ratchet check: the ways test/ can silence a type error that neither
 * `check-test-typecheck` nor `check-test-as-unknown-as` counts.
 *
 * Issue #1514 phase 3c. Draining those two baselines is only real progress if
 * the debt cannot walk out through a side door, and there are four:
 *
 *   asAny        `as any` — invisible to both ratchets. Biome's noExplicitAny
 *                would catch it, but that rule is deferred for test/** until
 *                the drain lands (see biome.json), so it is counted here
 *                instead. When the rule turns on, this counter retires.
 *   tsSuppress   `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` — removes a
 *                typecheck error without fixing anything.
 *   ratchetAllow `test-ratchet-allow: as-unknown-as` — the cast ratchet's own
 *                escape hatch. Legitimate occasionally, so it is ratcheted
 *                rather than banned.
 *   absentValue  `absentValue<T>()` / `nullValue<T>()` from
 *                test/helpers/absent.ts — a deliberately-absent value fed to a
 *                parameter whose type forbids it, because the absence is the
 *                assertion. Counts the call sites of the idiom that replaced
 *                `undefined as unknown as T` / `null as unknown as T`.
 *
 * Every counter fails on growth only; all four shrink as the drain proceeds.
 *
 * Usage:
 *   bun scripts/check-test-escape-hatches.ts                   # check (CI mode)
 *   bun scripts/check-test-escape-hatches.ts --update-baseline # save new baseline
 *   bun scripts/check-test-escape-hatches.ts --list            # print per-file counts
 *
 * Exit codes:
 *   0 — no counter grew
 *   1 — at least one counter grew, or the baseline is missing
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const SCAN_DIR = "test";
const BASELINE_FILE = join(import.meta.dir, "baselines", "test-escape-hatches-baseline.json");

/** Counted per match, not per line: a line-based count lets two hatches be
 *  joined onto one line to lower the number without removing either. */
const PATTERNS = {
  asAny: /\bas\s+any\b/g,
  tsSuppress: /@ts-(expect-error|ignore|nocheck)\b/g,
  ratchetAllow: /test-ratchet-allow:\s*as-unknown-as/g,
  absentValue: /\b(absentValue|nullValue)\s*</g,
} as const;

export type HatchKind = keyof typeof PATTERNS;
export type Counts = Record<HatchKind, number>;

const HATCH_KINDS = Object.keys(PATTERNS) as HatchKind[];

/**
 * The ratchet scripts' own test files contain these patterns inside fixture
 * strings that verify the scanner finds them. Skip them so the ratchet does
 * not grade its own scaffolding.
 */
const EXEMPT_FILES = new Set<string>([
  "test/unit/scripts/check-test-typecheck.test.ts",
  "test/unit/scripts/check-test-as-unknown-as.test.ts",
  "test/unit/scripts/check-test-escape-hatches.test.ts",
  // The idiom's own definition — its `absentValue<T>()` / `nullValue<T>()`
  // declarations match the call-site pattern. Counting definitions would
  // double-count the type-lie: the counter exists to ratchet CALL SITES.
  "test/helpers/absent.ts",
]);

interface Baseline {
  counts: Counts;
  updatedAt: string;
  byFile?: Record<string, Partial<Counts>>;
}

export interface RatchetOutcome {
  ok: boolean;
  message: string;
  grown: HatchKind[];
}

export interface ScanResult {
  counts: Counts;
  byFile: Record<string, Partial<Counts>>;
}

function emptyCounts(): Counts {
  return { asAny: 0, tsSuppress: 0, ratchetAllow: 0, absentValue: 0 };
}

export async function scanEscapeHatches(rootDir: string): Promise<ScanResult> {
  const counts = emptyCounts();
  const byFile: Record<string, Partial<Counts>> = {};
  const glob = new Glob("**/*.ts");
  for await (const file of glob.scan({ cwd: join(rootDir, SCAN_DIR), absolute: false })) {
    if (file.endsWith(".d.ts")) continue;
    const rel = join(SCAN_DIR, file);
    if (EXEMPT_FILES.has(rel)) continue;
    const text = await Bun.file(join(rootDir, rel)).text();
    for (const kind of HATCH_KINDS) {
      const matches = text.match(PATTERNS[kind]);
      if (matches === null) continue;
      counts[kind] += matches.length;
      byFile[rel] = { ...byFile[rel], [kind]: matches.length };
    }
  }
  return { counts, byFile };
}

export function formatReport(current: ScanResult, baseline: Baseline | null): RatchetOutcome {
  const { counts, byFile } = current;
  const summary = HATCH_KINDS.map((k) => `${k}=${counts[k]}`).join(", ");

  if (baseline === null) {
    return {
      ok: false,
      message:
        `[FAIL] No baseline found. Run \`bun scripts/check-test-escape-hatches.ts --update-baseline\` first.\n` +
        `Current: ${summary}.`,
      grown: [],
    };
  }

  const grown = HATCH_KINDS.filter((k) => counts[k] > (baseline.counts[k] ?? 0));
  if (grown.length === 0) {
    const shrunk = HATCH_KINDS.filter((k) => counts[k] < (baseline.counts[k] ?? 0)).map(
      (k) => `${k} ↓ ${(baseline.counts[k] ?? 0) - counts[k]}`,
    );
    const note = shrunk.length > 0 ? ` (${shrunk.join(", ")})` : "";
    return { ok: true, message: `[OK] test/ escape hatches: ${summary}${note}.`, grown: [] };
  }

  const lines = [`[FAIL] test/ escape hatches grew: ${summary}.`];
  for (const kind of grown) {
    const base = baseline.counts[kind] ?? 0;
    lines.push(`  ${kind}: ${base} → ${counts[kind]} (+${counts[kind] - base})`);
    const offenders = Object.keys(byFile)
      .map((f) => ({ f, now: byFile[f]?.[kind] ?? 0, was: baseline.byFile?.[f]?.[kind] ?? 0 }))
      .filter((o) => o.now > o.was)
      .sort((a, b) => b.now - a.now);
    for (const o of offenders) lines.push(`    ${o.f}  (was ${o.was}, now ${o.now})`);
  }
  lines.push(
    "",
    "These silence a type error without fixing it, so the typecheck and cast",
    "ratchets cannot see the debt. Fix the fixture or the helper's return type",
    "instead — see .nax/rules/test-ratchets.md.",
  );
  return { ok: false, message: lines.join("\n"), grown };
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(current: ScanResult) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      { counts: current.counts, updatedAt: new Date().toISOString(), byFile: current.byFile },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const current = await scanEscapeHatches(ROOT);

  if (args.includes("--list")) {
    const rows = Object.entries(current.byFile)
      .map(([file, c]) => ({ file, total: HATCH_KINDS.reduce((s, k) => s + (c[k] ?? 0), 0), c }))
      .sort((a, b) => b.total - a.total);
    for (const r of rows) {
      console.log(
        `${r.total.toString().padStart(4)}  ${HATCH_KINDS.map((k) => `${k}=${r.c[k] ?? 0}`).join(" ")}  ${r.file}`,
      );
    }
    console.log(`\nTotals: ${HATCH_KINDS.map((k) => `${k}=${current.counts[k]}`).join(", ")}`);
    return;
  }

  if (args.includes("--update-baseline")) {
    saveBaseline(current);
    console.log(`[OK] Baseline saved: ${HATCH_KINDS.map((k) => `${k}=${current.counts[k]}`).join(", ")}.`);
    return;
  }

  const { ok, message } = formatReport(current, loadBaseline());
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
