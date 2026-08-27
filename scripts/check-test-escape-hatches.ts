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
 *   asAny        `as any` — invisible to both ratchets. DRAINED: biome's
 *                noExplicitAny is now `error` for test/** too (biome.json),
 *                and reads 0. This counter did NOT retire with it, because
 *                biome sees code and this sees text: the residue it still
 *                baselines is `as any` inside comments and parser-fixture
 *                strings, which no lint rule will ever cover. Treat a rise
 *                as a regression, not as a drain to resume.
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
 *                it. A superset of `asAny`, and DRAINED with it (biome 1529 →
 *                0). Same reason for staying: its baseline is prose and
 *                fixture strings biome cannot see.
 *   looseCast    single `as T` casts. NOT a drain target, and MORE
 *                load-bearing now than when it was written: with
 *                `check-test-as-unknown-as` baselined at 0 and test/
 *                typecheck a hard gate at 0, an unmarked single `as X` is the
 *                cheapest remaining way to buy a green build. This guards the
 *                TS2352 population ("convert the expression to `unknown`
 *                first") from walking out under a name the closed ratchet no
 *                longer sees. Driving it down is not progress; keeping it
 *                from rising is.
 *   asNever      `as never` — assignable to EVERY type, so it silences any
 *                assignment error outright. Lowercase, so `looseCast` (which
 *                anchors on an uppercase initial) never saw it. DRAINED, 603 →
 *                1, and SUPERSEDED: biome-plugins/no-as-never.grit is a GritQL
 *                plugin scoped to `test/**` in biome.json, and a plugin
 *                diagnostic is a hard error that fails `bun run lint`. That
 *                rule is now the measure; this counter did NOT retire with it,
 *                for the same reason `asAny` and `nonNullAssert` did not — a
 *                parser sees code, this sees text, and the 1 site still
 *                baselined is a doc comment quoting the phrase.
 *                The claim this doc used to make — "no biome rule covers this
 *                shape" — was true of biome's BUILT-IN rules and stopped being
 *                true with v2's GritQL plugins. Before writing that about
 *                `ratchetAllow`, `tsSuppress` or `absentValue`, check whether a
 *                plugin can express the shape; `absentValue` almost certainly
 *                can. See docs/plans/STATUS-test-debt-drain.md §8.8.
 *   nonNullAssert
 *                postfix `!`. Narrows away null/undefined with no runtime
 *                check. DRAINED: biome's `noNonNullAssertion` is now `error`
 *                for test/** and reads 0; the 2 matches still baselined here
 *                are prose and a parser fixture.
 *                HISTORICAL NOTE, kept because the lesson generalises: this
 *                regex undercounted badly. At the drain's start biome found
 *                1064 sites against this pattern's 792 — 272 that NOTHING
 *                counted. Draining to 0 as measured HERE would have left them
 *                live and failed the promote-back on a red build. Where a
 *                lint rule can see the same shape, it is the finish line and
 *                this is not. See the regex's own doc comment for why (raw
 *                text, no parser) and
 *                docs/plans/archive/LOG-non-null-assertion-drain.md.
 *
 * Every counter fails on growth only. Four are drained and now hold a residue
 * of comments and fixture strings no parser will ever cover; `looseCast` is a
 * guard that is not meant to fall; `asNever`, `ratchetAllow`, `tsSuppress` and
 * `absentValue` are what is left to drain.
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
 * warnings, and both drains retire into no enforcement at all. See
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
   * The cheapest possible way to silence a `TS7006 implicit any` without
   * fixing it. A superset of `asAny`. Both are drained (biome 1529 → 0) but
   * neither retired: biome parses code, this reads text, and the residue is
   * comments and parser fixtures.
   *
   * Anchored to a type-position prefix on purpose. A bare /\bany\b/ also
   * matches the ENGLISH WORD in comments and fixture strings — 262 of them
   * in test/ today — so writing a doc comment containing "any" would trip
   * the ratchet and invite gaming it. Do not "simplify" this pattern.
   */
  anyType: /(?:\bas\s+any\b|[:<|&,(]\s*any\b)/g,
  /**
   * Single `as T` casts. NOT a drain target — this exists so the `TS2352`
   * population ("convert the expression to `unknown` first") cannot escape
   * into unmarked single casts. With the cast ratchet baselined at 0, that
   * job matters more, not less: a single `as X` is now the cheapest way to
   * reintroduce the debt under a name the closed ratchet does not see.
   */
  looseCast: /\bas\s+[A-Z]\w*/g,
  /**
   * `as never`. The bottom type is assignable to every other type, so this
   * silences ANY assignment error in one word — including the whole
   * `Mock<() => X>`-into-a-typed-dep-slot family. `looseCast` anchors on
   * `as [A-Z]` and `never` is lowercase, so for the first two phases of the
   * drain this walked out uncounted; 619 of them accumulated. Deliberately
   * its own counter rather than a `looseCast` widening: the two retire on
   * different timelines — `asNever` is being drained, `looseCast` is a guard
   * that stays.
   */
  asNever: /\bas\s+never\b/g,
  /**
   * Postfix `!` — the non-null assertion. Discards `null`/`undefined` from a
   * type with no runtime check, so it clears `TS18047`/`TS18048` while leaving
   * the unsafe access exactly as it was. Since the drain closed, biome's
   * `noNonNullAssertion` is `error` for `test/**` too and is the real gate;
   * this counter now guards only the text biome cannot parse.
   *
   * Anchored to POSTFIX position — an identifier, `)` or `]`, then `!`, then a
   * member/argument/terminator character. That excludes prefix negation
   * (`!x`, `!!x`), `!=`, `!==`, and the common `"…!"` fixture string. It
   * undercounts rather than over-: `x! + 1` and an end-of-line `!` are missed.
   *
   * One false positive survives and is pinned by a test: prose punctuation
   * inside a string, as in `"wow!, really"`. The 2 sites this still baselines
   * are of exactly that family — a doc comment and a declaration fixture.
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
  // Same, for the `as never` biome plugin's gate test. Its fixtures are source
  // strings fed to biome, and this counter reads 11 of them where the plugin
  // itself — which parses — reads 0. A neat demonstration of why the plugin,
  // not this regex, is now the measure for `asNever`.
  ["test/unit/scripts/biome-no-as-never-plugin.test.ts", ALL_KINDS],
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
  // `{ts,tsx}`, not `**/*.ts`: test/ui/ is six .tsx files, and while the glob
  // read only `.ts` they were invisible to every counter here. That hid six
  // real `as never` sites for the whole drain — the same "zero on the ratchet
  // was not zero on the rule" failure as the noNonNullAssertion undercount,
  // with a glob ceiling instead of a regex one.
  const glob = new Glob("**/*.{ts,tsx}");
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
