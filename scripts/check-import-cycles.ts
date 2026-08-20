#!/usr/bin/env bun
/**
 * Ratchet check: prevents new runtime import cycles from being added.
 *
 * A "runtime cycle" is a loop in the value-import graph of `src/`. Type-only
 * imports are excluded: TypeScript erases them, so they cannot participate in
 * a runtime initialisation order.
 *
 * Cycles matter because ESM evaluates modules in dependency order. When a
 * cycle exists, one participant observes a partially-initialised binding of
 * another (`undefined` at module scope), which surfaces as a crash on first
 * use rather than at import time.
 *
 * Barrels are the dominant source: `dir/index.ts` re-exports `dir/leaf.ts`,
 * and `leaf.ts` imports a sibling through the same barrel. This check exists
 * so that migrating imports onto barrels (the rule enforced by
 * `check-alias-internals.ts`) cannot silently deepen the problem.
 *
 * Usage:
 *   bun scripts/check-import-cycles.ts                   # check (CI mode)
 *   bun scripts/check-import-cycles.ts --update-baseline # save new baseline
 *   bun scripts/check-import-cycles.ts --list            # print all cycles
 *
 * Exit codes:
 *   0 — no new cycles (count <= baseline)
 *   1 — ratchet breached (count > baseline) or baseline missing
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE_FILE = join(import.meta.dir, "baselines", "import-cycles-baseline.json");
const SCAN_DIR = "src";

/** Extensions tried, in order, when resolving a specifier to a file on disk. */
const RESOLVE_SUFFIXES = ["/index.ts", ".ts", ".tsx"] as const;

/** Captures the import/export prelude in group 1 and the specifier in group 2. */
const STATIC_IMPORT_RE = /((?:import|export)\s+(?:type\s+)?[^"']*?)from\s+["']([^"']+)["']/g;

export interface ImportCycle {
  /** Repo-relative files in cycle order; the first also closes the loop. */
  files: string[];
  /** Stable identity: the rotation-invariant join of `files`. */
  key: string;
}

interface Baseline {
  count: number;
  updatedAt: string;
  /** Cycle keys present when the baseline was saved, for precise diffing. */
  keys?: string[];
}

function isTypeOnlyImport(prelude: string): boolean {
  return /^\s*(?:import|export)\s+type\b/.test(prelude);
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) yield full;
  }
}

/**
 * Resolve an import specifier to an absolute file path, or null when it is
 * external (a bare package) or unresolvable.
 */
export function resolveSpecifier(rootDir: string, fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(rootDir, "src", spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(fromFile), spec);
  else return null;

  // `.js` specifiers are TypeScript's ESM convention for a sibling `.ts` file.
  base = base.replace(/\.js$/, "");

  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  if (existsSync(base) && statSync(base).isFile()) return base;
  return null;
}

/** Build the value-import graph of `src/`, keyed by absolute file path. */
export function buildImportGraph(rootDir: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of walk(join(rootDir, SCAN_DIR))) {
    const content = readFileSync(file, "utf8");
    const deps: string[] = [];
    STATIC_IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STATIC_IMPORT_RE.exec(content)) !== null) {
      if (isTypeOnlyImport(match[1] ?? "")) continue;
      const spec = match[2];
      if (!spec) continue;
      const target = resolveSpecifier(rootDir, file, spec);
      if (target) deps.push(target);
    }
    graph.set(file, deps);
  }
  return graph;
}

/**
 * Rotation-invariant identity for a cycle: the same loop discovered from a
 * different entry point yields the same key.
 */
function cycleKey(files: readonly string[]): string {
  let best: string | null = null;
  for (let i = 0; i < files.length; i++) {
    const rotated = [...files.slice(i), ...files.slice(0, i)].join(" -> ");
    if (best === null || rotated < best) best = rotated;
  }
  return best ?? "";
}

const UNVISITED = 0;
const ON_STACK = 1;
const DONE = 2;

export function findImportCycles(rootDir: string): ImportCycle[] {
  const graph = buildImportGraph(rootDir);
  const state = new Map<string, number>();
  const stack: string[] = [];
  const seen = new Map<string, ImportCycle>();

  function visit(node: string): void {
    state.set(node, ON_STACK);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      const depState = state.get(dep) ?? UNVISITED;
      if (depState === ON_STACK) {
        const start = stack.indexOf(dep);
        const files = stack.slice(start).map((f) => relative(rootDir, f));
        const key = cycleKey(files);
        if (!seen.has(key)) seen.set(key, { files, key });
      } else if (depState === UNVISITED) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, DONE);
  }

  for (const node of [...graph.keys()].sort()) {
    if ((state.get(node) ?? UNVISITED) === UNVISITED) visit(node);
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(cycles: readonly ImportCycle[]): void {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  const body = {
    count: cycles.length,
    updatedAt: new Date().toISOString(),
    keys: cycles.map((c) => c.key),
  };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`[OK] Baseline saved: ${cycles.length} runtime import cycles in src/.`);
}

export function formatReport(
  cycles: readonly ImportCycle[],
  baseline: Baseline | null,
): { message: string; ok: boolean } {
  const count = cycles.length;

  if (baseline === null) {
    return {
      ok: false,
      message: "[FAIL] No baseline found. Run `bun scripts/check-import-cycles.ts --update-baseline` first.",
    };
  }

  const delta = count - baseline.count;
  if (delta <= 0) {
    const improved = delta < 0 ? ` (down ${Math.abs(delta)} since last baseline)` : "";
    return {
      ok: true,
      message: `[OK] ${count} runtime import cycles (baseline: ${baseline.count})${improved}.`,
    };
  }

  const known = new Set(baseline.keys ?? []);
  const added = cycles.filter((c) => !known.has(c.key));
  const lines = [
    `[FAIL] ${delta} new runtime import cycle(s) added (${count} total, baseline: ${baseline.count}).`,
    "A cycle means one module reads a partially-initialised binding of another at load time.",
    "Break it by importing the leaf module directly instead of routing through a barrel.",
    "",
    `New cycles (${added.length}):`,
  ];
  for (const c of added) lines.push(`  ${c.files.join(" -> ")} -> ${c.files[0]}`);

  return { ok: false, message: lines.join("\n") };
}

function main(): void {
  const args = process.argv.slice(2);
  const cycles = findImportCycles(ROOT);

  if (args.includes("--update-baseline")) {
    saveBaseline(cycles);
    return;
  }

  if (args.includes("--list")) {
    for (const c of cycles) console.log(`${c.files.join(" -> ")} -> ${c.files[0]}`);
    console.log(`\nTotal: ${cycles.length}`);
    return;
  }

  const { ok, message } = formatReport(cycles, loadBaseline());
  if (ok) {
    console.log(message);
  } else {
    console.error(message);
    process.exit(1);
  }
}

if (import.meta.main) main();
