#!/usr/bin/env bun
/**
 * Test-consolidation ranker.
 *
 * The drain tracked by docs/plans/STATUS-test-consolidation-drain.md needs its counters
 * re-measured after every task, and a ranking that says which group to do next. This
 * script is that measurement loop.
 *
 * What it finds: "satellite" test files. A satellite is `<dir>/<base>-<suffix>.test.ts`
 * sitting beside `<dir>/<base>.test.ts`. `.nax/rules/test-architecture.md` allows
 * `<module>-<concern>.test.ts` ONLY as a describe-block split of an oversized file, and
 * forbids standalone bug-fix files outright ("Placement Rules" §2). In practice the
 * satellites accumulated one nax story at a time, so most encode an issue number rather
 * than a concern — that is the violation this ranks for repair.
 *
 * What it deliberately EXCLUDES (all learned from a review that caught the first version
 * getting each one wrong — see the STATUS doc §8.1):
 *
 *   - **Mirrors.** A satellite with a same-named `src/` module is the rule's own ideal
 *     ("One test file per source file"), not a violation. `test/unit/config/schemas-model.test.ts`
 *     is the test file for `src/config/schemas-model.ts`. Merging it would BREAK the rule.
 *     Mirrors are reported separately and never counted as removable.
 *   - **Nested groups.** A base can itself be another base's satellite
 *     (`story-orchestrator-revalidation` is both). Counting both double-counts the lines
 *     and gives conflicting instructions, so every file is assigned to its OUTERMOST
 *     ancestor and nested bases are not reported as groups of their own.
 *   - **Frozen bases.** A base listed in scripts/baselines/file-sizes-baseline.json may not
 *     grow (the ratchet fails on growth), so it is pinned as a bin that receives nothing.
 *     Note the baseline records a file's size when it was grandfathered; a file that has
 *     since shrunk has real headroom up to its RECORDED number, which this accounts for.
 *
 * Why not scripts/report-test-overlap.ts or report-dead-tests.ts: both were RETIRED
 * 2026-09-21 (STATUS §9.36). Both parsed only `src/`-prefixed import specifiers, but this
 * repo's tests import through the `@/` alias (measured 2026-09-21: 4,549 alias imports vs
 * 27 literal `src/` ones), so both reported ~nothing. See §1.6 of the STATUS doc.
 *
 * Usage:
 *   bun run report:test-consolidation                          # ranked table + headline counts
 *   bun run report:test-consolidation --group <base-path>      # one group, with the merge arithmetic
 *   bun run report:test-consolidation --mirrors                # the do-not-merge list
 *   bun run report:test-consolidation --json                   # machine-readable
 *
 * Exit codes: 0 on a successful report; 1 if --group names no group or an ambiguous one.
 *
 * The pure primitives (`walk`, `readStat`, `buildGroups`, `packGroup`, and the
 * constants above them) are exported so `scripts/check-test-satellites.ts` and its
 * unit test can reuse one definition of "satellite"/"ticket"/"mirror" instead of
 * re-implementing them. Everything that scans the repo or writes to stdout lives in
 * `main()`, run only under `import.meta.main`, so importing this module is free of
 * side effects (it used to scan and `process.exit` at module load).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** `check-file-sizes.ts` TEST_LIMIT. A merged file above this breaks `bun run lint`. */
export const TEST_LINE_LIMIT = 800;

/**
 * Target fill for a merged file, below the hard cap.
 *
 * Packing to 800 leaves the next bug fix nowhere legal to go: the module's test file is
 * full and a new `<module>-<ticket>.test.ts` is what this drain exists to remove. Leaving
 * ~150 lines per file keeps the drain from creating the problem it fixes.
 */
export const FILL_TARGET = 650;

/** Scanned population. `test/e2e/` is its own CI step (`bun run test:e2e`) and is out of scope. */
export const SCAN_DIRS = ["test/unit", "test/integration", "test/ui"];

/** Names/headers matching this encode a ticket rather than a concern — rule §2 violations. */
export const TICKET_RE = /(#\s?\d{3,4}|nax#\d+|\bUS-\d+\b|\bAC\d+\b|ADR-\d+|issue\s?\d+|BUG-\d+|Task \d+)/i;

/**
 * Only the shared-helper and fixture ROOTS are skipped, not every directory named
 * `helpers`: `test/unit/helpers/*.test.ts` are real tests of the helpers and belong in
 * the population (the first version skipped them and under-counted by 3).
 */
export const SKIP_ROOTS = new Set(["test/helpers", "test/fixtures", "test/.tmp", "test/tmp"]);

const BASELINE_PATH = join(import.meta.dir, "baselines", "file-sizes-baseline.json");

/** Match `check-file-sizes.ts` countLines exactly: a trailing newline is not a line. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export type RestoreKind =
  /** Mutates `_deps` and restores it (afterEach / finally / withDepsRestore). */
  | "restored"
  /** Mutates `_deps` with no restore of any kind — a genuine merge hazard. */
  | "unrestored"
  /** Mutates `_deps` and has a hook, but no restore is visible. Needs a human read. */
  | "unclear"
  /** Does not mutate a module-level `_deps`. */
  | "n/a";

export type FileStat = {
  path: string;
  /** Static `test(`/`it(` sites. NOT the runtime test count — `.each` expands at runtime. */
  staticTests: number;
  /** `.each` sites, each of which expands to N tests at runtime. */
  eachSites: number;
  expects: number;
  lines: number;
  /** Lines before the first column-0 `describe(` — imports, helpers, fixtures. */
  preamble: number;
  ticket: boolean;
  restore: RestoreKind;
  /** Has a same-named `src/` module, so it is the rule-compliant test file for it. */
  mirror: boolean;
  /** Recorded size in file-sizes-baseline.json, if grandfathered. */
  frozenAt?: number;
  describes: string[];
};

export function walk(dir: string, out: string[] = []): string[] {
  if (SKIP_ROOTS.has(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) out.push(rel);
  }
  return out;
}

/** Does a `src/` module of the same name exist for this test path? */
export function mirrorsSrcModule(testPath: string): boolean {
  const stem = testPath.replace(/^test\/(unit|integration|ui)\//, "src/").replace(/\.test\.tsx?$/, "");
  return [".ts", ".tsx", "/index.ts", "/index.tsx"].some((suffix) => existsSync(join(ROOT, stem + suffix)));
}

/** Brace-match the body of every `name(` call site and return the bodies. */
function hookBodies(content: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const m of content.matchAll(re)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    out.push(content.slice((m.index ?? 0) + m[0].length, i - 1));
  }
  return out;
}

const DEPS_ASSIGN = /_\w*[Dd]eps\s*(?:\.\s*\w+\s*=|\[)|Object\.assign\(\s*_\w*[Dd]eps/;

/**
 * Classify whether a file that stubs a module-level `_deps` puts it back.
 *
 * The repo uses three restore idioms and the first version of this script knew only one
 * ("the file contains the word afterEach"), which produced 48 false positives AND missed
 * files whose `afterEach` restores something else entirely. Both matter: the false
 * positives sent Task 1 at correct code, the false negatives hid real hazards inside
 * groups the table showed as clean.
 */
export function classifyRestore(content: string): RestoreKind {
  if (!DEPS_ASSIGN.test(content)) return "n/a";
  if (/withDepsRestore/.test(content)) return "restored";
  if (/finally\s*\{/.test(content)) return "restored";
  const hooks = [...hookBodies(content, "afterEach"), ...hookBodies(content, "afterAll")];
  if (hooks.some((body) => DEPS_ASSIGN.test(body))) return "restored";
  if (hooks.length > 0) return "unclear";
  return "unrestored";
}

export function readStat(path: string, frozen: Record<string, number> = {}): FileStat {
  const content = readFileSync(join(ROOT, path), "utf8");
  const firstDescribe = content.search(/^describe\s*\(/m);
  return {
    path,
    staticTests: [...content.matchAll(/^[ \t]*(?:test|it)(?:\.(?:skip|todo|failing|only|if|skipIf))?\s*[(<]/gm)].length,
    eachSites: [...content.matchAll(/^[ \t]*(?:test|it)(?:\.\w+)*\.each\s*[(<]/gm)].length,
    expects: [...content.matchAll(/\bexpect\(/g)].length,
    lines: countLines(content),
    preamble: firstDescribe >= 0 ? countLines(content.slice(0, firstDescribe)) : 0,
    ticket: TICKET_RE.test(basename(path)) || TICKET_RE.test(content.slice(0, 2000)),
    restore: classifyRestore(content),
    mirror: mirrorsSrcModule(path),
    frozenAt: frozen[path],
    describes: [...content.matchAll(/describe\(\s*["'`]([^"'`]+)/g)].map((m) => m[1]),
  };
}

/**
 * Assign each file to its OUTERMOST base — the SHORTEST hyphen-prefix in the same
 * directory that is itself a test file — so nested groups collapse into one.
 */
export function buildGroups(paths: string[]): Map<string, string[]> {
  const present = new Set(paths);
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirname(path);
    const stem = basename(path).replace(/\.test\.tsx?$/, "");
    const parts = stem.split("-");
    for (let n = 1; n < parts.length; n++) {
      const prefix = parts.slice(0, n).join("-");
      const candidate = [`${dir}/${prefix}.test.ts`, `${dir}/${prefix}.test.tsx`].find((c) => present.has(c));
      if (candidate) {
        if (!groups.has(candidate)) groups.set(candidate, []);
        groups.get(candidate)?.push(path);
        break;
      }
    }
  }
  // Drop bases that are themselves someone else's satellite; their members already
  // belong to the outer group by construction.
  const claimed = new Set([...groups.values()].flat());
  for (const base of [...groups.keys()]) if (claimed.has(base)) groups.delete(base);
  return groups;
}

export type Bin = { lines: number; members: string[]; frozen: boolean };

/**
 * First-fit-decreasing pack of a group's mergeable members into files.
 *
 * Three corrections over the first version, each of which produced an unbuildable plan:
 *   - A bin's preamble is the MAX of its members' preambles (their imports and fixtures
 *     union, they do not average). Charging the mean understated every bin.
 *   - A new bin is never allowed past TEST_LINE_LIMIT; a member whose body alone exceeds
 *     the budget gets its own bin and is reported as unmergeable.
 *   - A frozen base is pinned as a bin that receives nothing, up to its RECORDED size.
 */
export function packGroup(members: FileStat[], basePath: string): { bins: Bin[]; unmergeable: string[] } {
  const bins: Bin[] = [];
  const unmergeable: string[] = [];

  const mergeable: FileStat[] = [];
  for (const m of members) {
    // A frozen file stays put. So does a SATELLITE that mirrors its own src module — but
    // the base mirrors its src module by definition and is the receiver, not an exclusion.
    if (m.frozenAt !== undefined || (m.mirror && m.path !== basePath)) {
      bins.push({ lines: m.lines, members: [m.path], frozen: true });
      if (m.frozenAt !== undefined && m.lines >= m.frozenAt) unmergeable.push(m.path);
    } else mergeable.push(m);
  }

  for (const m of [...mergeable].sort((a, b) => b.lines - a.lines)) {
    const body = m.lines - m.preamble;
    const slot = bins.find(
      (b) => !b.frozen && Math.max(b.lines, 0) + body <= FILL_TARGET && b.lines + body <= TEST_LINE_LIMIT,
    );
    if (slot) {
      slot.lines += body;
      slot.members.push(m.path);
      continue;
    }
    if (m.preamble + body > TEST_LINE_LIMIT) {
      bins.push({ lines: m.lines, members: [m.path], frozen: true });
      unmergeable.push(m.path);
      continue;
    }
    bins.push({ lines: m.preamble + body, members: [m.path], frozen: false });
  }
  return { bins, unmergeable };
}

export type Row = {
  base: string;
  members: number;
  /** Satellites excluding mirrors — the population this drain may touch. */
  satellites: number;
  mirrors: string[];
  staticTests: number;
  expects: number;
  lines: number;
  packedFiles: number;
  packedLines: number;
  removableFiles: number;
  removableLines: number;
  ticketSatellites: number;
  unrestored: string[];
  unclear: string[];
  unmergeable: string[];
  frozenBases: string[];
};

async function main() {
  const frozen: Record<string, number> = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")).byFile ?? {})
    : {};

  const paths = SCAN_DIRS.flatMap((d) => walk(d));
  const stats = new Map(paths.map((p) => [p, readStat(p, frozen)] as const));
  const groups = buildGroups(paths);

  const rows: Row[] = [];
  for (const [base, satellites] of groups) {
    const all = [base, ...satellites].map((p) => stats.get(p) as FileStat);
    const { bins, unmergeable } = packGroup(all, base);
    const lines = all.reduce((a, m) => a + m.lines, 0);
    const packedLines = bins.reduce((a, b) => a + b.lines, 0);
    rows.push({
      base,
      members: all.length,
      satellites: satellites.filter((p) => !stats.get(p)?.mirror).length,
      mirrors: all.filter((m) => m.mirror && m.path !== base).map((m) => m.path),
      staticTests: all.reduce((a, m) => a + m.staticTests, 0),
      expects: all.reduce((a, m) => a + m.expects, 0),
      lines,
      packedFiles: bins.length,
      packedLines,
      removableFiles: all.length - bins.length,
      removableLines: lines - packedLines,
      ticketSatellites: satellites.filter((p) => stats.get(p)?.ticket && !stats.get(p)?.mirror).length,
      unrestored: all.filter((m) => m.restore === "unrestored").map((m) => m.path),
      unclear: all.filter((m) => m.restore === "unclear").map((m) => m.path),
      unmergeable,
      frozenBases: all.filter((m) => m.frozenAt !== undefined).map((m) => m.path),
    });
  }
  rows.sort((a, b) => b.removableFiles - a.removableFiles || b.removableLines - a.removableLines);

  const argv = process.argv.slice(2);

  if (argv.includes("--mirrors")) {
    const satellitePaths = new Set([...groups.values()].flat());
    const mirrors = paths.filter((p) => stats.get(p)?.mirror && satellitePaths.has(p));
    console.log(`Mirrors — satellites that ARE the per-source test file. NEVER merge these. (${mirrors.length})`);
    for (const p of mirrors.sort()) {
      const stem = p.replace(/^test\/(unit|integration|ui)\//, "src/").replace(/\.test\.tsx?$/, "");
      const src = [".ts", ".tsx", "/index.ts"].map((s) => stem + s).find((s) => existsSync(join(ROOT, s)));
      console.log(`  ${p}\n      → ${src}`);
    }
    process.exit(0);
  }

  if (argv.includes("--group")) {
    const requested = argv[argv.indexOf("--group") + 1];
    if (!requested) {
      console.error("--group needs a base test path. Run without --group to list the groups.");
      process.exit(1);
    }
    const matches = rows.filter((r) => r.base === requested || r.base.endsWith(`/${requested}`));
    if (matches.length === 0) {
      console.error(`No group with base ${requested}. Run without --group to list them.`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Ambiguous: ${requested} matches ${matches.length} groups. Use the full path:`);
      for (const m of matches) console.error(`    ${m.base}`);
      process.exit(1);
    }
    const row = matches[0];
    const all = [row.base, ...(groups.get(row.base) ?? [])];
    const { bins } = packGroup(
      all.map((p) => stats.get(p) as FileStat),
      row.base,
    );
    console.log(`GROUP ${row.base}`);
    console.log(
      `  ${row.members} files, ${row.staticTests} static test sites, ${row.expects} expect(), ${row.lines} lines`,
    );
    console.log(
      `  packs to ${row.packedFiles} files / ${row.packedLines} lines  (-${row.removableFiles} files, -${row.removableLines} lines)`,
    );
    console.log(`  fill target ${FILL_TARGET}, hard cap ${TEST_LINE_LIMIT}`);
    if (row.mirrors.length) {
      console.log(`\n  MIRRORS — do NOT merge, each is its own src module's test file:`);
      for (const p of row.mirrors) console.log(`      ${p}`);
    }
    if (row.frozenBases.length) {
      console.log(`\n  FROZEN (file-sizes-baseline) — receives nothing:`);
      for (const p of row.frozenBases) {
        const s = stats.get(p) as FileStat;
        const head = (s.frozenAt ?? 0) - s.lines;
        console.log(
          `      ${p}  ${s.lines}l, recorded ${s.frozenAt}l${head > 0 ? ` (${head}l headroom)` : " (no headroom)"}`,
        );
      }
    }
    if (row.unrestored.length) {
      console.log(`\n  ⚠ mutates _deps with NO restore — fix before merging:`);
      for (const p of row.unrestored) console.log(`      ${p}`);
    }
    if (row.unclear.length) {
      console.log(`\n  ? mutates _deps, has a hook, no restore detected — READ before merging:`);
      for (const p of row.unclear) console.log(`      ${p}`);
    }
    console.log(`\n  proposed packing:`);
    for (const [i, b] of bins.entries()) {
      console.log(`    bin ${i + 1}: ${b.lines}l${b.frozen ? " (pinned)" : ""}`);
      for (const p of b.members) {
        const s = stats.get(p) as FileStat;
        console.log(
          `        ${String(s.lines).padStart(4)}l (preamble ${String(s.preamble).padStart(3)}, body ${String(s.lines - s.preamble).padStart(4)})  ${p}`,
        );
      }
    }
    console.log(`\n  members in detail:`);
    for (const p of all) {
      const s = stats.get(p) as FileStat;
      const flags = [
        s.mirror ? "MIRROR" : "",
        s.ticket ? "ticket" : "",
        s.restore === "unrestored" ? "deps!" : "",
        s.restore === "unclear" ? "deps?" : "",
      ]
        .filter(Boolean)
        .join(",");
      console.log(`  ${String(s.staticTests).padStart(3)}t ${String(s.lines).padStart(4)}l ${flags.padEnd(20)} ${p}`);
      for (const d of s.describes) console.log(`        describe: ${d.slice(0, 96)}`);
    }
    process.exit(0);
  }

  const allStats = [...stats.values()];
  const totals = {
    scope: SCAN_DIRS.join(" + "),
    files: paths.length,
    staticTests: allStats.reduce((a, s) => a + s.staticTests, 0),
    eachSites: allStats.reduce((a, s) => a + s.eachSites, 0),
    expects: allStats.reduce((a, s) => a + s.expects, 0),
    lines: allStats.reduce((a, s) => a + s.lines, 0),
    groups: rows.length,
    satellites: rows.reduce((a, r) => a + r.satellites, 0),
    mirrors: rows.reduce((a, r) => a + r.mirrors.length, 0),
    ticketSatellites: rows.reduce((a, r) => a + r.ticketSatellites, 0),
    removableFiles: rows.reduce((a, r) => a + r.removableFiles, 0),
    removableLines: rows.reduce((a, r) => a + r.removableLines, 0),
    unrestored: [...new Set(rows.flatMap((r) => r.unrestored))].length,
    unclear: [...new Set(rows.flatMap((r) => r.unclear))].length,
  };

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ totals, rows }, null, 2));
    process.exit(0);
  }

  console.log("Test-consolidation ranker");
  console.log(`  scope              ${totals.scope}  (test/e2e/ excluded — separate CI step)`);
  console.log(`  scanned            ${totals.files} files, ${totals.lines} lines, ${totals.expects} expect()`);
  console.log(
    `  static test sites  ${totals.staticTests}  + ${totals.eachSites} .each sites — NOT the runtime count, use \`bun test\``,
  );
  console.log(`  satellite groups   ${totals.groups}  (nested bases collapsed into their outermost ancestor)`);
  console.log(
    `  satellites         ${totals.satellites}  (${totals.ticketSatellites} encode a ticket — rule §2 violations)`,
  );
  console.log(`  mirrors            ${totals.mirrors}  EXCLUDED — each is its own src module's test file (--mirrors)`);
  console.log(
    `  _deps unrestored   ${totals.unrestored} files with no restore; ${totals.unclear} need a read (hook, no visible restore)`,
  );
  console.log(
    `  removable files    ${totals.removableFiles}   (packed to ${FILL_TARGET}, hard cap ${TEST_LINE_LIMIT})`,
  );
  console.log(`  removable lines    ${totals.removableLines}`);
  console.log("");
  console.log("  -files  -lines  files→packed  base");
  for (const r of rows.filter((x) => x.removableFiles > 0)) {
    const flags = [
      r.unrestored.length ? "⚠deps" : "",
      r.unclear.length ? "?deps" : "",
      r.mirrors.length ? `${r.mirrors.length}mirror` : "",
      r.unmergeable.length ? "pinned" : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `  ${String(r.removableFiles).padStart(6)}  ${String(r.removableLines).padStart(6)}  ${String(r.members).padStart(5)}→${String(r.packedFiles).padEnd(5)}  ${r.base}${flags ? `  ${flags}` : ""}`,
    );
  }
  console.log("");
  console.log(`  groups already at their floor: ${rows.filter((r) => r.removableFiles <= 0).length}`);
}

if (import.meta.main) {
  await main();
}
