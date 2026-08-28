#!/usr/bin/env bun
/**
 * Ratchet check: the ways test/ can silence a type error that no parser sees.
 *
 * Issue #1514 phase 3c. Draining the typecheck baseline is only real progress
 * if the debt cannot walk out through a side door.
 *
 * SCOPE — this counts only what biome cannot. Five counters that once lived
 * here retired on 2026-08-27 once a parser gated each of their shapes at
 * `error`, because a text regex kept as a "secondary guard" behind a working
 * rule guards nothing: its whole residue was prose and fixture strings, so it
 * could only ever fire on a comment. What retired, and what now measures it:
 *
 *   asAny, anyType       biome `noExplicitAny`, `error` for test/** (biome.json)
 *   nonNullAssert        biome `noNonNullAssertion`, `error` for test/**
 *   asNever              biome-plugins/no-as-never.grit (GritQL plugin)
 *   absentValue          biome-plugins/no-absent-value.grit (GritQL plugin)
 *
 * `@ts-expect-error` alone also has a rule now — biome `noTsIgnore`, promoted from
 * its shipped WARN to `error` on 2026-08-27. `tsSuppress` still counts it: the
 * counter covers three directives and is the ONLY gate for the other two, so
 * splitting it to avoid overlap would buy nothing and open a gap.
 *
 * A plugin diagnostic is a hard error, so `bun run lint` fails on any of the
 * four. Their drains are in docs/plans/archive/LOG-*.md and their final
 * baselines in this file's git history; the retirement is
 * docs/plans/STATUS-test-debt-drain.md §8.14. Do NOT reintroduce a counter
 * here for a shape biome already parses — fix the rule instead.
 *
 * The three that remain have no parser behind them and are the measure:
 *
 *   tsSuppress   `@ts-expect-error` / `@ts-expect-error` / `@ts-nocheck` — removes a
 *                typecheck error without fixing anything. A comment shape, so
 *                correctly text-mode: biome parses code, and comments are
 *                TRIVIA in its CST — `comment()` / `js_comment()` do not even
 *                compile as GritQL patterns, so no plugin can replace this.
 *                **Baselined at 0** since the pattern was anchored to the
 *                comment opener; any nonzero reading is a regression to fix at
 *                the site, not a number to work down.
 *   ratchetAllow `test-ratchet-allow: as-unknown-as` — the cast ratchet's own
 *                escape hatch. Legitimate occasionally, so it is ratcheted
 *                rather than banned. Also a comment shape.
 *   looseCast    single `as T` casts. NOT a drain target, and MORE
 *                load-bearing now than when it was written: with
 *                `check-test-as-unknown-as` baselined at 0 and test/
 *                typecheck a hard gate at 0, an unmarked single `as X` is the
 *                cheapest remaining way to buy a green build. This guards the
 *                TS2352 population ("convert the expression to `unknown`
 *                first") from walking out under a name the closed ratchet no
 *                longer sees. Driving it down is not progress; keeping it
 *                from rising is.
 *
 * Every counter fails on growth only. `tsSuppress` is a closed invariant at 0.
 * `ratchetAllow` is at its floor (STATUS §8.9) and that floor is NOT zero:
 * each of its 25 sites builds a deliberately-illegal value for a function
 * whose job is surviving contract violations (a string where the type says
 * number), so the cast IS the test. Draining it would delete the coverage.
 *
 * The companion `check-test-typecheck` ratchet this once named alongside it is
 * gone: `test/` reached 0 errors (#1514 §47), so `bun run typecheck` now
 * compiles `tsconfig.test.json` outright and a hard gate replaced the count.
 *
 * SEVERITY POLICY (decided 2026-08-25, Biome v2 rollout step 4; DISCHARGED
 * 2026-08-26): `noExplicitAny` and `noNonNullAssertion` were `error` for src/
 * and bin/ and `off` for test/** only because thousands of existing sites
 * would have failed the build — an exemption that was a consequence of the
 * debt, not a judgement that test/ deserves looser rules. Both drains have
 * landed and both rules are now `error` for test/** as well.
 *
 * The promote-back was done by SETTING "error" in the test/** override, NOT by
 * deleting the override. Do not "tidy up" by deleting it: under Biome v2 that
 * lands the rules at default WARNING severity, `biome check` exits 0 on
 * warnings, and both drains retire into no enforcement at all — which is
 * exactly the failure this file no longer has a counter to catch. See
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
  /**
   * `@ts-expect-error` / `@ts-expect-error` / `@ts-nocheck` — a typecheck error
   * removed without fixing anything.
   *
   * Anchored to the comment OPENER, which is where TypeScript requires a real
   * directive to sit: the first text in the comment. Unanchored, this read the
   * words wherever they appeared, and its entire remaining population was
   * PROSE — a comment in `run-regression.test.ts` explaining why that test
   * asserts at the type level *instead of* suppressing. §4 forbids deleting
   * such a comment to lower a count, which makes the regex the defect and not
   * the code: the counter is now a closed invariant at 0.
   *
   * Deliberately NOT anchored to the start of a line. `foo(); // @ts-expect-error`
   * is a real suppression, and `^` would miss it — the same undercount the
   * `nonNullAssert` regex made 272 times and the `**\/*.ts` glob made six.
   * A directive inside a string literal still counts; over-counting is the
   * safe direction, and the scanner's own fixtures are exempt by path.
   */
  tsSuppress: /(?:\/\/|\/\*+|^[ \t]*\*)[ \t]*@ts-(expect-error|ignore|nocheck)\b/gm,
  ratchetAllow: /test-ratchet-allow:\s*as-unknown-as/g,
  /**
   * Single `as T` casts. NOT a drain target — this exists so the `TS2352`
   * population ("convert the expression to `unknown` first") cannot escape
   * into unmarked single casts. With the cast ratchet baselined at 0, that
   * job matters more, not less: a single `as X` is now the cheapest way to
   * reintroduce the debt under a name the closed ratchet does not see.
   *
   * Anchored on `as [A-Z]`, which is why `as never` needed a separate counter
   * for two phases of its drain — 619 lowercase sites walked out uncounted.
   * That shape is now biome-plugins/no-as-never.grit's job, but the anchor
   * remains: any NEW lowercase bottom-ish type is invisible here too.
   */
  looseCast: /\bas\s+[A-Z]\w*/g,
} as const;

export type HatchKind = keyof typeof PATTERNS;
export type Counts = Record<HatchKind, number>;

const HATCH_KINDS = Object.keys(PATTERNS) as HatchKind[];

/**
 * Per-kind exemptions. Scoped deliberately: a file exempt from one counter is
 * still graded by every other one. See GitHub #1682.
 */
const ALL_KINDS: ReadonlySet<HatchKind> = new Set(HATCH_KINDS);

export type Exemptions = ReadonlyMap<string, ReadonlySet<HatchKind>>;

export const EXEMPT_BY_KIND: Exemptions = new Map([
  // Scanner scaffolding: fixture strings legitimately contain every pattern.
  ["test/unit/scripts/check-test-as-unknown-as.test.ts", ALL_KINDS],
  ["test/unit/scripts/check-test-escape-hatches.test.ts", ALL_KINDS],
  // Same, for the `as never` biome plugin's gate test. Its fixtures are source
  // strings fed to biome; among them is `{} as Error`, a NEGATIVE control
  // proving the plugin does not fire on an ordinary cast — which is exactly
  // the shape `looseCast` counts. The fixture is scaffolding, not debt.
  ["test/unit/scripts/biome-no-as-never-plugin.test.ts", ALL_KINDS],
  // Same again: the biome severity gate lints planted source strings, and one
  // of them is a real `// @ts-expect-error` directive it needs `noTsIgnore` to fire
  // on. Counting it here would baseline `tsSuppress` at 1 forever and lose the
  // closed-invariant-at-0 property the anchored pattern just bought.
  ["test/unit/scripts/biome-test-severity.test.ts", ALL_KINDS],
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

/**
 * `exemptions` is a parameter, not a closed-over constant, so the per-kind
 * scoping of GitHub #1682 stays testable. Every entry in the live map happens
 * to be `ALL_KINDS` today, and without this seam a test could no longer reach
 * the "exempt from one counter, still graded by the rest" branch at all.
 */
export async function scanEscapeHatches(rootDir: string, exemptions: Exemptions = EXEMPT_BY_KIND): Promise<ScanResult> {
  const counts = emptyCounts();
  const byFile: Record<string, Partial<Counts>> = {};
  // `{ts,tsx}`, not `**/*.ts`: test/ui/ is six .tsx files, and while the glob
  // read only `.ts` they were invisible to every counter here. That hid six
  // real `as never` sites for the whole drain — the same "zero on the ratchet
  // was not zero on the rule" failure as the noNonNullAssertion undercount,
  // with a glob ceiling instead of a regex one.
  const glob = new Glob("**/*.{ts,tsx}");
  for await (const file of glob.scan({ cwd: join(rootDir, SCAN_DIR), absolute: false })) {
    if (file.endsWith(".d.ts")) continue;
    const rel = join(SCAN_DIR, file);
    const exempt = exemptions.get(rel);
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
