#!/usr/bin/env bun
/**
 * Ratchet check: the ways test/ can silence a type error that
 * `check-test-as-unknown-as` does not count.
 *
 * Issue #1514 phase 3c. Draining that baseline is only real progress if the
 * debt cannot walk out through a side door, and there are eight:
 *
 * The companion `check-test-typecheck` ratchet this once named alongside it is
 * gone: `test/` reached 0 errors (#1514 §47), so `bun run typecheck` now
 * compiles `tsconfig.test.json` outright and a hard gate replaced the count.
 *
 *   asAny        `as any` — invisible to both ratchets. Biome's noExplicitAny
 *                is `error` everywhere EXCEPT test/**, where the override
 *                still turns it off until the drain lands (see biome.json and
 *                the note below). Counted here instead; retires when the
 *                override is promoted back to `error`.
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
 *   anyType      `any` in TYPE position — `: any`, `<any>`, `as any`. The
 *                cheapest way to silence a TS7006 implicit any without fixing
 *                it. A superset of `asAny`; both retire together when biome's
 *                noExplicitAny turns on for test/**.
 *   looseCast    single `as T` casts. NOT a drain target — guards the 189
 *                TS2352 errors ("convert the expression to `unknown` first")
 *                from escaping into unmarked single casts while the cast
 *                ratchet is at its floor.
 *   asNever      `as never` — assignable to EVERY type, so it silences any
 *                assignment error outright. Lowercase, so `looseCast` (which
 *                anchors on an uppercase initial) never saw it.
 *   nonNullAssert
 *                postfix `!`. Narrows away null/undefined with no runtime
 *                check and no counter — and biome's `noNonNullAssertion` is
 *                off for test/** (biome.json), so nothing else sees it either.
 *                NOTE: this counter is known to undercount. Measured
 *                2026-08-25, biome's own noNonNullAssertion finds 1092 in
 *                test/ against this regex's 819 — 273 sites that NOTHING
 *                counts. See the regex's own doc comment for why (raw text,
 *                no parser). Do not read the baseline as the true total.
 *
 * Every counter fails on growth only; all eight shrink as the drain proceeds.
 *
 * SEVERITY POLICY (decided 2026-08-25, Biome v2 rollout step 4):
 * `noExplicitAny` and `noNonNullAssertion` are `error` for src/ and bin/,
 * where both are already at zero, so the gate costs nothing and new
 * violations fail `bun run lint`. They stay `off` for test/** ONLY because
 * 2943 existing sites would fail the build; the exemption is a consequence of
 * the debt, not a judgement that test/ deserves looser rules.
 *
 * When asAny/anyType and nonNullAssert reach zero, the test/** override must
 * be PROMOTED BACK to `error` — not deleted. Deleting it lands the rules at
 * v2's default warning severity, `biome check` exits 0 on warnings, and the
 * whole drain would retire into no enforcement at all. See
 * docs/findings/biome-migration-risk.md.
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
  /**
   * `any` in TYPE position — `: any`, `<any>`, `Record<string, any>`, `as any`.
   * Uncounted until now, and the cheapest possible way to silence a
   * `TS7006 implicit any` without fixing it. A superset of `asAny`; both
   * retire together when biome's `noExplicitAny` is enabled for `test/**`.
   *
   * Anchored to a type-position prefix on purpose. A bare /\bany\b/ also
   * matches the ENGLISH WORD in comments and fixture strings — 262 of them
   * in test/ today — so writing a doc comment containing "any" would trip
   * the ratchet and invite gaming it. Do not "simplify" this pattern.
   */
  anyType: /(?:\bas\s+any\b|[:<|&,(]\s*any\b)/g,
  /**
   * Single `as T` casts. NOT a drain target — this exists so the 189 `TS2352`
   * errors ("convert the expression to `unknown` first") cannot escape into
   * unmarked single casts while the cast ratchet is at its floor.
   */
  looseCast: /\bas\s+[A-Z]\w*/g,
  /**
   * `as never`. The bottom type is assignable to every other type, so this
   * silences ANY assignment error in one word — including the whole
   * `Mock<() => X>`-into-a-typed-dep-slot family that dominates the remaining
   * residue. `looseCast` anchors on `as [A-Z]` and `never` is lowercase, so
   * for the first two phases of the drain this walked out uncounted; 619 of
   * them accumulated. Deliberately its own counter rather than a `looseCast`
   * widening: the two retire on different timelines.
   */
  asNever: /\bas\s+never\b/g,
  /**
   * Postfix `!` — the non-null assertion. Discards `null`/`undefined` from a
   * type with no runtime check, so it clears `TS18047`/`TS18048` while leaving
   * the unsafe access exactly as it was. Nothing else in the repo sees it:
   * biome's `noNonNullAssertion` is `off` for `test/**` (biome.json).
   *
   * Anchored to POSTFIX position — an identifier, `)` or `]`, then `!`, then a
   * member/argument/terminator character. That excludes prefix negation
   * (`!x`, `!!x`), `!=`, `!==`, and the common `"…!"` fixture string. It
   * undercounts rather than over-: `x! + 1` and an end-of-line `!` are missed.
   *
   * One false positive survives and is pinned by a test: prose punctuation
   * inside a string, as in `"wow!, really"`. There are none in test/ today.
   * Doing better needs a parser — like `anyType` above, this is a raw-text
   * regex and inherits that ceiling.
   */
  nonNullAssert: /[A-Za-z0-9_$)\]]!(?=[.,;)\]])/g,
} as const;

export type HatchKind = keyof typeof PATTERNS;
export type Counts = Record<HatchKind, number>;

const HATCH_KINDS = Object.keys(PATTERNS) as HatchKind[];

/**
 * Per-kind exemptions. Scoped deliberately: a file exempt from one counter is
 * still graded by every other one. See GitHub #1682.
 */
const ALL_KINDS: ReadonlySet<HatchKind> = new Set(HATCH_KINDS);

const EXEMPT_BY_KIND: ReadonlyMap<string, ReadonlySet<HatchKind>> = new Map([
  // Scanner scaffolding: fixture strings legitimately contain every pattern.
  ["test/unit/scripts/check-test-as-unknown-as.test.ts", ALL_KINDS],
  ["test/unit/scripts/check-test-escape-hatches.test.ts", ALL_KINDS],
  // The idiom's own definition. Its declarations match the CALL-SITE pattern;
  // counting them would inflate `absentValue` by 2 forever. Every other
  // counter still applies to this file.
  ["test/helpers/absent.ts", new Set(["absentValue"])],
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
  return Object.fromEntries(HATCH_KINDS.map((k) => [k, 0])) as Counts;
}

export async function scanEscapeHatches(rootDir: string): Promise<ScanResult> {
  const counts = emptyCounts();
  const byFile: Record<string, Partial<Counts>> = {};
  const glob = new Glob("**/*.ts");
  for await (const file of glob.scan({ cwd: join(rootDir, SCAN_DIR), absolute: false })) {
    if (file.endsWith(".d.ts")) continue;
    const rel = join(SCAN_DIR, file);
    const exempt = EXEMPT_BY_KIND.get(rel);
    const text = await Bun.file(join(rootDir, rel)).text();
    // `as unknown as Foo` ends in something `looseCast` would match, and the
    // cast ratchet already counts it. Strip it for that counter only.
    const looseText = text.replace(/\bas\s+unknown\s+as\b/g, "");
    for (const kind of HATCH_KINDS) {
      if (exempt?.has(kind)) continue;
      const matches = (kind === "looseCast" ? looseText : text).match(PATTERNS[kind]);
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
