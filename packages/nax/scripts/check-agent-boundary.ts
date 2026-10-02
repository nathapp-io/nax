#!/usr/bin/env bun
/**
 * S1 ratchet: counts import edges that leave the nax-agent move set.
 *
 * The move set is scripts/s1-move-manifest.json. An edge is a (file, file)
 * pair where the importer is in the move set and the imported src/ file is
 * not. Type-only imports count (a moved file cannot type-import nax either),
 * and so do `import("...")` type references and side-effect imports. Bare
 * package specifiers are not edges.
 *
 * The count may only fall. It must read 0 before the S1-5 move starts
 * (spec section 6); S1-5 then replaces this ratchet with
 * check-package-boundaries.
 *
 * Usage:
 *   bun scripts/check-agent-boundary.ts                   # check (CI mode)
 *   bun scripts/check-agent-boundary.ts --update-baseline # save new baseline
 *   bun scripts/check-agent-boundary.ts --list            # print every edge
 *
 * Exit codes:
 *   0 - count <= baseline
 *   1 - count > baseline, or baseline missing
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { resolveSpecifier, walk } from "./check-import-cycles";
import { isInMoveSet, loadMoveManifest, type MoveManifest } from "./lib/agent-move-manifest";
import { specifiersOf } from "./lib/import-specifiers";

export { specifiersOf } from "./lib/import-specifiers";

const ROOT = join(import.meta.dir, "..");
const BASELINE_FILE = join(import.meta.dir, "baselines", "agent-boundary-baseline.json");
const MANIFEST_FILE = join(import.meta.dir, "s1-move-manifest.json");

export interface BoundaryEdge {
  readonly from: string;
  readonly to: string;
}

interface Baseline {
  count: number;
  updatedAt: string;
  edges: string[];
}

function toRel(rootDir: string, file: string): string {
  return relative(rootDir, file).split(sep).join("/");
}

export function formatEdge(e: BoundaryEdge): string {
  return `${e.from} -> ${e.to}`;
}

export function findBoundaryEdges(rootDir: string, manifest: MoveManifest): BoundaryEdge[] {
  const seen = new Set<string>();
  const edges: BoundaryEdge[] = [];
  for (const file of walk(join(rootDir, "src"))) {
    const from = toRel(rootDir, file);
    if (!isInMoveSet(manifest, from)) continue;
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(rootDir, file, spec);
      if (target === null) continue;
      const to = toRel(rootDir, target);
      if (isInMoveSet(manifest, to)) continue;
      const edge = { from, to };
      const key = formatEdge(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }
  return edges.sort((a, b) => byCodePoint(formatEdge(a), formatEdge(b)));
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_FILE)) return null;
  return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
}

function saveBaseline(edges: readonly BoundaryEdge[]): void {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  const baseline: Baseline = { count: edges.length, updatedAt: new Date().toISOString(), edges: edges.map(formatEdge) };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const edges = findBoundaryEdges(ROOT, loadMoveManifest(MANIFEST_FILE));

  if (args.includes("--list")) {
    for (const e of edges) console.log(formatEdge(e));
    console.log(`${edges.length} boundary edge(s)`);
    return;
  }
  if (args.includes("--update-baseline")) {
    saveBaseline(edges);
    console.log(`[OK] agent-boundary baseline saved: ${edges.length} edge(s)`);
    return;
  }

  const baseline = loadBaseline();
  if (baseline === null) {
    console.error("[FAIL] agent-boundary baseline missing; run with --update-baseline");
    process.exit(1);
  }
  if (edges.length > baseline.count) {
    const known = new Set(baseline.edges);
    console.error(`[FAIL] agent-boundary edges rose: ${edges.length} > baseline ${baseline.count}. New edges:`);
    for (const e of edges) if (!known.has(formatEdge(e))) console.error(`  ${formatEdge(e)}`);
    process.exit(1);
  }
  if (edges.length < baseline.count) {
    console.log(
      `[OK] agent-boundary edges fell to ${edges.length} (baseline ${baseline.count}); run --update-baseline to lock it in`,
    );
    return;
  }
  console.log(`[OK] agent-boundary edges: ${edges.length}`);
}

if (import.meta.main) main();
