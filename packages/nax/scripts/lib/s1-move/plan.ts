/**
 * S1-5 move plan: which files leave packages/nax for packages/nax-agent, and
 * where they land (S1 spec sections 6 and 8).
 *
 * - Sources: every file the manifest names.
 * - Tests: a test moves when it imports at least one moving source, imports no
 *   source that stays, and every test helper it reaches is free of nax imports.
 *   Tests that read files from disk need an explicit ruling (the two lists below).
 * - Helpers: every helper a moving test reaches. nax keeps a one-line shim at the
 *   old path, so its own tests and barrel are untouched.
 * - Fixtures: data files a moving test reads, listed by hand.
 *
 * Paths: `from` is relative to packages/nax, `to` to packages/nax-agent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { byCodePoint } from "@/utils/sort";
import { destinationOf, isInMoveSet, type MoveManifest } from "../agent-move-manifest";
import { specifierSites } from "../import-specifiers";
import { isLocalSpecifier, resolveInPackage } from "./resolve";

export interface FileMove {
  readonly from: string;
  readonly to: string;
}

export interface MovePlan {
  readonly sources: readonly FileMove[];
  readonly tests: readonly FileMove[];
  readonly helpers: readonly FileMove[];
  readonly fixtures: readonly FileMove[];
}

/** Read nax files from disk and must stay with them, although their imports would let them move. */
export const STAY_IN_NAX: ReadonlySet<string> = new Set(["test/unit/execution/command-interceptor.test.ts"]);
/**
 * Mention the disk but stay valid after the move: one reads a fixture relative to
 * its own location (the mirrored destination keeps the path), two only pass the
 * cwd as a harmless working directory.
 */
export const MOVE_DESPITE_DISK: ReadonlySet<string> = new Set([
  "test/unit/command-safety/corpus-fixture.test.ts",
  "test/unit/sandbox/srt-backend.test.ts",
  "test/unit/utils/argv-exec.test.ts",
]);
/** Data files that move with the tests that read them. */
export const FIXTURES: readonly string[] = ["test/fixtures/command-safety/corpus.jsonl"];

const BARREL = "test/helpers/index.ts";
const DISK_MARKER = /import\.meta\.(?:dir|url)|__dirname|process\.cwd\(\)/;
const TEST_FILE = /\.test\.tsx?$/;
const SOURCE_FILE = /\.tsx?$/;
const BARREL_EXPORT = /export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

export function listFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const child = `${rel}/${name}`;
      if (statSync(join(root, child)).isDirectory()) visit(child);
      else out.push(child);
    }
  };
  visit(dir);
  return out.sort(byCodePoint);
}

/** `a`, `type B`, `c as d` -> the names as exported (`a`, `B`, `d`). */
export function exportedNames(clause: string): string[] {
  return clause
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter((part) => part.length > 0)
    .map((part) => part.split(/\s+as\s+/).pop() ?? part);
}

/** `a`, `type B`, `c as d` -> the names as imported from the module (`a`, `B`, `c`). */
export function importedNames(clause: string): string[] {
  return clause
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter((part) => part.length > 0)
    .map((part) => part.split(/\s+as\s+/)[0] ?? part);
}

/** Barrel name -> helper module (package-relative), from the barrel's named re-exports. */
export function barrelMap(root: string): Map<string, string> {
  const text = readFileSync(join(root, BARREL), "utf8");
  if (/^export\s*\*/m.test(text)) throw new Error(`${BARREL} uses export *; the move script maps names per module`);
  const map = new Map<string, string>();
  for (const m of text.matchAll(BARREL_EXPORT)) {
    const target = resolveInPackage(root, BARREL, m[2] ?? "");
    if (target === null) throw new Error(`${BARREL}: cannot resolve ${m[2]}`);
    for (const name of exportedNames(m[1] ?? "")) map.set(name, target);
  }
  return map;
}

interface TestImports {
  readonly sources: string[];
  readonly helpers: string[];
  readonly unresolved: string[];
}

function clauseOf(prelude: string): string | null {
  return prelude.match(/\{([^}]*)\}/)?.[1] ?? null;
}

function helpersFromBarrel(prelude: string, barrel: Map<string, string>): string[] {
  const clause = clauseOf(prelude);
  if (clause === null) return [...new Set(barrel.values())];
  return importedNames(clause).map((name) => barrel.get(name) ?? `${BARREL}#${name}`);
}

export function importsOf(root: string, rel: string, barrel: Map<string, string>): TestImports {
  const result: TestImports = { sources: [], helpers: [], unresolved: [] };
  for (const site of specifierSites(readFileSync(join(root, rel), "utf8"))) {
    if (!isLocalSpecifier(site.spec)) continue;
    const target = resolveInPackage(root, rel, site.spec);
    if (target === null) result.unresolved.push(site.spec);
    else if (target === BARREL) result.helpers.push(...helpersFromBarrel(site.prelude, barrel));
    else if (target.startsWith("src/")) result.sources.push(target);
    else result.helpers.push(target);
  }
  return result;
}

/** Memoised: does this non-test file under test/ reach only moving sources? */
export function makeHelperCheck(
  root: string,
  manifest: MoveManifest,
  barrel: Map<string, string>,
): (helper: string) => boolean {
  const memo = new Map<string, boolean>();
  const check = (helper: string): boolean => {
    const known = memo.get(helper);
    if (known !== undefined) return known;
    memo.set(helper, true); // optimistic while in progress: a cycle cannot make itself nax-bound
    if (!helper.startsWith("test/") || TEST_FILE.test(helper) || helper.includes("#")) {
      memo.set(helper, false);
      return false;
    }
    const imports = importsOf(root, helper, barrel);
    const free =
      imports.unresolved.length === 0 &&
      imports.sources.every((s) => isInMoveSet(manifest, s)) &&
      imports.helpers.every(check);
    memo.set(helper, free);
    return free;
  };
  return check;
}

export function helperClosure(root: string, seeds: Iterable<string>, barrel: Map<string, string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const helper = stack.pop();
    if (helper === undefined || seen.has(helper)) continue;
    seen.add(helper);
    stack.push(...importsOf(root, helper, barrel).helpers);
  }
  return seen;
}

/** Where a moving test lands: its directory mirrors the manifest move of the source it tests. */
export function testDestination(manifest: MoveManifest, rel: string): string {
  const m = rel.match(/^test\/([^/]+)\/(.*)$/);
  if (m === null) return rel;
  const [, suite, rest = ""] = m;
  const dir = dirname(rest);
  const file = basename(rest);
  const prefix = dir === "." ? "src" : `src/${dir}`;
  const mirrored =
    destinationOf(manifest, `${prefix}/${file.replace(TEST_FILE, ".ts")}`) ??
    destinationOf(manifest, `${prefix}/__mirror_probe__.ts`);
  if (mirrored === undefined) return rel;
  const destDir = dirname(mirrored);
  return destDir === "." ? `test/${suite}/${file}` : `test/${suite}/${destDir}/${file}`;
}

export type TestRuling = "move" | "stay" | "needs-ruling";

export function classifyTest(
  root: string,
  manifest: MoveManifest,
  rel: string,
  barrel: Map<string, string>,
  helperIsFree: (helper: string) => boolean,
): TestRuling {
  if (STAY_IN_NAX.has(rel)) return "stay";
  const imports = importsOf(root, rel, barrel);
  const movable =
    imports.sources.length > 0 &&
    imports.unresolved.length === 0 &&
    imports.sources.every((s) => isInMoveSet(manifest, s)) &&
    imports.helpers.every(helperIsFree);
  if (!movable) return "stay";
  const readsDisk = DISK_MARKER.test(readFileSync(join(root, rel), "utf8"));
  if (readsDisk && !MOVE_DESPITE_DISK.has(rel)) return "needs-ruling";
  return "move";
}

function assertNoCollisions(moves: readonly FileMove[]): void {
  const seen = new Map<string, string>();
  for (const move of moves) {
    const other = seen.get(move.to);
    if (other !== undefined) throw new Error(`${other} and ${move.from} both land at ${move.to}`);
    seen.set(move.to, move.from);
  }
}

export function buildMovePlan(root: string, manifest: MoveManifest): MovePlan {
  const sources = listFiles(root, "src")
    .filter((rel) => SOURCE_FILE.test(rel) && isInMoveSet(manifest, rel))
    .map((rel) => ({ from: rel, to: `src/${destinationOf(manifest, rel)}` }));
  const barrel = barrelMap(root);
  const helperIsFree = makeHelperCheck(root, manifest, barrel);
  const tests: FileMove[] = [];
  const needsRuling: string[] = [];
  for (const rel of listFiles(root, "test").filter((r) => TEST_FILE.test(r))) {
    const ruling = classifyTest(root, manifest, rel, barrel, helperIsFree);
    if (ruling === "move") tests.push({ from: rel, to: testDestination(manifest, rel) });
    if (ruling === "needs-ruling") needsRuling.push(rel);
  }
  if (needsRuling.length > 0) {
    throw new Error(
      `tests that read from disk need a ruling (STAY_IN_NAX or MOVE_DESPITE_DISK):\n  ${needsRuling.join("\n  ")}`,
    );
  }
  const seeds = tests.flatMap((t) => importsOf(root, t.from, barrel).helpers);
  const helpers = [...helperClosure(root, seeds, barrel)].sort(byCodePoint).map((rel) => ({ from: rel, to: rel }));
  const fixtures = FIXTURES.map((rel) => ({ from: rel, to: rel }));
  const plan = { sources, tests, helpers, fixtures };
  assertNoCollisions([...sources, ...tests, ...helpers, ...fixtures]);
  return plan;
}
