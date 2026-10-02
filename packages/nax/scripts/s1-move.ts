#!/usr/bin/env bun
/**
 * S1-5: moves the nax-agent move set (scripts/s1-move-manifest.json) out of
 * packages/nax into a new workspace package, packages/nax-agent (S1 spec
 * section 6). Deleted by the same PR once it has run.
 *
 * Usage, from packages/nax on a clean tree:
 *   bun scripts/s1-move.ts --dry-run   # print the plan and the rewrite errors, write nothing
 *   bun scripts/s1-move.ts             # move, rewrite, scaffold, `bun install`, format
 *
 * Every rewrite is computed against the original layout before anything moves.
 * Any boundary error (a moved file reaching a file that stays, a wholesale
 * re-export of a moved module) aborts the run with the tree untouched.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadMoveManifest } from "./lib/agent-move-manifest";
import {
  assertDistinctNamespaces,
  renderHelperBarrel,
  renderHelperShim,
  renderIndex,
  renderInternal,
} from "./lib/s1-move/entries";
import { buildMovePlan, type FileMove, listFiles, type MovePlan } from "./lib/s1-move/plan";
import { type InternalNeeds, rewriteMovedFile, rewriteStayingFile } from "./lib/s1-move/rewrite";
import { scaffoldFiles, withAgentDevDependency } from "./lib/s1-move/scaffold";

const NAX = join(import.meta.dir, "..");
const REPO = join(NAX, "..", "..");
const AGENT = join(REPO, "packages", "nax-agent");
const STAYING_DIRS = ["src", "bin", "scripts", "test"];
const CODE_FILE = /\.tsx?$/;
/** Moved tests that import nax's helper barrel import nax-agent's generated one instead. */
const HELPER_BARREL = "test/helpers/index.ts";

interface Writes {
  readonly moved: Map<string, string>;
  readonly staying: Map<string, string>;
  readonly needs: InternalNeeds;
  readonly errors: string[];
  /** Staying files that name a moved source path in a string or comment (reported, not rewritten). */
  readonly mentions: string[];
}

function allMoves(plan: MovePlan): FileMove[] {
  return [...plan.sources, ...plan.tests, ...plan.helpers, ...plan.fixtures];
}

function mentionsOf(rel: string, source: string, plan: MovePlan): string[] {
  return plan.sources.filter((s) => source.includes(s.from)).map((s) => `${rel} mentions ${s.from}`);
}

function computeWrites(plan: MovePlan): Writes {
  const moves = allMoves(plan);
  const dest = new Map(moves.map((m) => [m.from, m.to]));
  const writes: Writes = {
    moved: new Map(),
    staying: new Map(),
    needs: { modules: new Set(), namespaces: new Map() },
    errors: [],
    mentions: [],
  };
  const movedDest = new Map([...dest, [HELPER_BARREL, HELPER_BARREL]]);
  for (const move of moves.filter((m) => CODE_FILE.test(m.from))) {
    const result = rewriteMovedFile(NAX, move.from, readFileSync(join(NAX, move.from), "utf8"), movedDest);
    writes.moved.set(move.to, result.text);
    writes.errors.push(...result.errors);
  }
  const staying = STAYING_DIRS.flatMap((d) => listFiles(NAX, d)).filter((f) => CODE_FILE.test(f) && !dest.has(f));
  for (const rel of staying) {
    const source = readFileSync(join(NAX, rel), "utf8");
    const result = rewriteStayingFile(NAX, rel, source, dest, writes.needs);
    if (result.text !== source) writes.staying.set(rel, result.text);
    writes.errors.push(...result.errors);
    writes.mentions.push(...mentionsOf(rel, source, plan));
  }
  writes.errors.push(...assertDistinctNamespaces(writes.needs.namespaces));
  return writes;
}

function run(argv: string[], cwd: string): void {
  const proc = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${proc.exitCode}`);
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function assertCleanTree(): void {
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO }).stdout.toString();
  if (status.trim() !== "") throw new Error(`the tree is not clean:\n${status}`);
}

function moveFiles(plan: MovePlan): void {
  for (const move of allMoves(plan)) {
    mkdirSync(dirname(join(AGENT, move.to)), { recursive: true });
    run(["git", "mv", join(NAX, move.from), join(AGENT, move.to)], REPO);
  }
}

function writeEverything(plan: MovePlan, writes: Writes): void {
  for (const [rel, text] of writes.moved) writeFile(join(AGENT, rel), text);
  for (const [rel, text] of writes.staying) writeFile(join(NAX, rel), text);
  for (const helper of plan.helpers) writeFile(join(NAX, helper.from), renderHelperShim(helper.from));
  writeFile(join(AGENT, "src/index.ts"), renderIndex(plan.sources.map((s) => s.to)));
  writeFile(join(AGENT, "src/internal.ts"), renderInternal(writes.needs.modules, writes.needs.namespaces));
  const naxBarrel = readFileSync(join(NAX, "test/helpers/index.ts"), "utf8");
  writeFile(
    join(AGENT, "test/helpers/index.ts"),
    renderHelperBarrel(
      naxBarrel,
      plan.helpers.map((h) => h.from),
    ),
  );
  const naxPkgText = readFileSync(join(NAX, "package.json"), "utf8");
  const naxBiome = JSON.parse(readFileSync(join(NAX, "biome.json"), "utf8"));
  for (const [rel, text] of scaffoldFiles(JSON.parse(naxPkgText), naxBiome)) writeFile(join(AGENT, rel), text);
  writeFile(join(NAX, "package.json"), withAgentDevDependency(naxPkgText));
}

function printPlan(plan: MovePlan, writes: Writes): void {
  const { sources, tests, helpers, fixtures } = plan;
  console.log(
    `sources ${sources.length}, tests ${tests.length}, helpers ${helpers.length}, fixtures ${fixtures.length}`,
  );
  console.log(
    `staying files rewritten ${writes.staying.size}; internal modules ${writes.needs.modules.size}; namespaces ${writes.needs.namespaces.size}`,
  );
  for (const t of tests) console.log(`  test ${t.from} -> ${t.to}`);
  for (const h of helpers) console.log(`  helper ${h.from}`);
  for (const m of writes.mentions) console.log(`  mention ${m}`);
  for (const u of plan.unmarkedDiskReaders) console.log(`  unmarked disk reader ${u}`);
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const plan = buildMovePlan(NAX, loadMoveManifest(join(import.meta.dir, "s1-move-manifest.json")));
  const writes = computeWrites(plan);
  printPlan(plan, writes);
  if (writes.errors.length > 0) {
    console.error(`[FAIL] ${writes.errors.length} boundary error(s):\n  ${writes.errors.join("\n  ")}`);
    process.exit(1);
  }
  if (dryRun) return;
  assertCleanTree();
  moveFiles(plan);
  writeEverything(plan, writes);
  run(["bun", "install"], REPO);
  run(["bun", "x", "biome", "check", "--write", "src/", "test/"], AGENT);
  run(["bun", "x", "biome", "check", "--write", ...writes.staying.keys()], NAX);
  console.log("[OK] moved. Next: plan Task 9, step 3 (typecheck both packages).");
}

if (import.meta.main) main();
