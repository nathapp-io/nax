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
 * What is counted: the number of `src/` modules that sit inside a cycle, not
 * the number of distinct loops. An earlier version enumerated simple cycles
 * with a depth-first search that marked each node `DONE` after its first
 * visit. That is a real false negative: within one strongly connected
 * component only the first loop discovered was ever reported, so a module
 * could be pulled into an existing component and the check would still read
 * clean. It did — see docs/specs/2026-08-20-deep-relatives-migration-runbook.md
 * section 7.2, where `check:import-cycles` reported 0 while a genuine cycle
 * crashed the test suite at module-init time.
 *
 * Enumerating every simple cycle instead is not an option: `src/`'s largest
 * component has 94 modules, and the number of simple cycles in a component
 * that size is astronomically large. Tarjan's strongly-connected-components
 * algorithm gives the complete answer in linear time — a module is in a cycle
 * exactly when its component has more than one member, or it imports itself —
 * and counting members means adding a module to an existing component moves
 * the number, which is the case the old check missed.
 *
 * Usage:
 *   bun scripts/check-import-cycles.ts                   # check (CI mode)
 *   bun scripts/check-import-cycles.ts --update-baseline # save new baseline
 *   bun scripts/check-import-cycles.ts --list            # print all cycles
 *
 * Exit codes:
 *   0 — no newly cyclic modules (count <= baseline)
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

export interface CyclicModule {
  /** Repo-relative path of a module that participates in a runtime cycle. */
  file: string;
  /**
   * A representative shortest cycle through `file`, in order. `file` is first
   * and also closes the loop, so the printed form appends it again.
   */
  cycle: string[];
}

interface Baseline {
  count: number;
  updatedAt: string;
  /** Cyclic modules present when the baseline was saved, for precise diffing. */
  modules?: string[];
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
 * Tarjan's strongly-connected-components algorithm over the value-import
 * graph. Iterative rather than recursive: `src/` is deep enough that a
 * recursive walk is an avoidable stack risk.
 */
function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of [...graph.keys()].sort()) {
    if (index.has(root)) continue;
    // Each frame tracks how far through its node's dependency list we are.
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    lowlink.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (!frame) break;
      const deps = graph.get(frame.node) ?? [];

      if (frame.next < deps.length) {
        const dep = deps[frame.next];
        frame.next++;
        if (dep === undefined || !graph.has(dep)) continue;
        if (!index.has(dep)) {
          index.set(dep, counter);
          lowlink.set(dep, counter);
          counter++;
          stack.push(dep);
          onStack.add(dep);
          work.push({ node: dep, next: 0 });
        } else if (onStack.has(dep)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node) ?? 0, index.get(dep) ?? 0));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node) ?? 0, lowlink.get(frame.node) ?? 0));
      }
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Shortest loop from `start` back to itself, restricted to its own component.
 * Used only for the error message — the ratchet counts modules, not loops.
 */
function shortestCycleThrough(start: string, graph: Map<string, string[]>, component: Set<string>): string[] {
  const previous = new Map<string, string>();
  const visited = new Set<string>([start]);
  const queue: string[] = [start];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const dep of graph.get(current) ?? []) {
      if (!component.has(dep)) continue;
      if (dep === start) {
        const tail: string[] = [];
        for (let node = current; node !== start; node = previous.get(node) ?? start) tail.push(node);
        return [start, ...tail.reverse()];
      }
      if (visited.has(dep)) continue;
      visited.add(dep);
      previous.set(dep, current);
      queue.push(dep);
    }
  }
  return [start];
}

/** Every `src/` module that participates in a runtime import cycle. */
export function findCyclicModules(rootDir: string): CyclicModule[] {
  const graph = buildImportGraph(rootDir);
  const found: CyclicModule[] = [];

  for (const component of stronglyConnectedComponents(graph)) {
    const first = component[0];
    if (first === undefined) continue;
    const isCyclic = component.length > 1 || (graph.get(first) ?? []).includes(first);
    if (!isCyclic) continue;

    const members = new Set(component);
    for (const member of component) {
      found.push({
        file: relative(rootDir, member),
        cycle: shortestCycleThrough(member, graph, members).map((f) => relative(rootDir, f)),
      });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(modules: readonly CyclicModule[]): void {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  const body = {
    count: modules.length,
    updatedAt: new Date().toISOString(),
    modules: modules.map((m) => m.file),
  };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`[OK] Baseline saved: ${modules.length} modules in runtime import cycles in src/.`);
}

function printCycle(module: CyclicModule): string {
  return `${module.cycle.join(" -> ")} -> ${module.cycle[0]}`;
}

export function formatReport(
  modules: readonly CyclicModule[],
  baseline: Baseline | null,
): { message: string; ok: boolean } {
  const count = modules.length;

  if (baseline === null) {
    return {
      ok: false,
      message: "[FAIL] No baseline found. Run `bun scripts/check-import-cycles.ts --update-baseline` first.",
    };
  }

  const delta = count - baseline.count;
  const known = new Set(baseline.modules ?? []);
  const added = modules.filter((m) => !known.has(m.file));

  // A net count is not enough: a change can pull one module into a cycle while
  // dropping two others out, leaving the total flat or lower. The per-module
  // baseline exists so that case still fails.
  if (delta <= 0 && added.length === 0) {
    const improved = delta < 0 ? ` (down ${Math.abs(delta)} since last baseline)` : "";
    return {
      ok: true,
      message: `[OK] ${count} modules in runtime import cycles (baseline: ${baseline.count})${improved}.`,
    };
  }

  const lines = [
    `[FAIL] ${added.length} module(s) newly inside a runtime import cycle (${count} total, baseline: ${baseline.count}).`,
    "A cycle means one module reads a partially-initialised binding of another at load time.",
    "Break it by importing the leaf module directly instead of routing through a barrel,",
    "or by promoting that leaf to its own nested barrel so the alias reaches it directly.",
    "",
    `Newly cyclic (${added.length}):`,
  ];
  for (const m of added) lines.push(`  ${printCycle(m)}`);

  return { ok: false, message: lines.join("\n") };
}

function main(): void {
  const args = process.argv.slice(2);
  const modules = findCyclicModules(ROOT);

  if (args.includes("--update-baseline")) {
    saveBaseline(modules);
    return;
  }

  if (args.includes("--list")) {
    for (const m of modules) console.log(`${m.file}  in  ${printCycle(m)}`);
    console.log(`\nTotal: ${modules.length}`);
    return;
  }

  const { ok, message } = formatReport(modules, loadBaseline());
  if (ok) {
    console.log(message);
  } else {
    console.error(message);
    process.exit(1);
  }
}

if (import.meta.main) main();
