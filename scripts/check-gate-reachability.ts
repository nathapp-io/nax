#!/usr/bin/env bun
/**
 * Meta-gate: every `scripts/check-*` gate must actually run in CI.
 *
 * Why this exists: the 2026-08-09 whole-repo gap analysis found eight quality
 * gates that were written, committed, documented — and invoked by no pipeline.
 * Wiring them one at a time does not stop the ninth from being added the same
 * way, so this gate asserts the *rule* instead: a check script that no CI entry
 * point reaches is a check script that does not exist.
 *
 * Reachability is resolved from two entry-point sources:
 *   1. `bun run check:all` in package.json, expanded transitively through
 *      other package scripts (so a gate inside `lint` counts).
 *   2. `.github/workflows/ci.yml` — every `run:` step, plus the `check:` build
 *      matrix, expanded the same way.
 *
 * Usage:
 *   bun scripts/check-gate-reachability.ts
 *
 * Exit codes:
 *   0 — every check script is reachable
 *   1 — one or more check scripts are unreachable (listed on stderr)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CI_WORKFLOW = join(".github", "workflows", "ci.yml");

/** A check script is any `scripts/check-*.ts` or `scripts/check-*.sh`. */
export function discoverCheckScripts(root: string): string[] {
  const dir = join(root, "scripts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(
    (name) =>
      name.startsWith("check-") && (name.endsWith(".ts") || name.endsWith(".sh"))
  );
}

export interface CiEntryPoints {
  /** package.json script names CI invokes, e.g. "lint", "check:all". */
  scriptNames: string[];
  /** scripts/ files CI invokes directly, e.g. "check-process-cwd.sh". */
  scriptFiles: string[];
}

const BUN_RUN_RE = /bun\s+run\s+([A-Za-z0-9:_-]+)/g;
const SCRIPT_FILE_RE = /scripts\/(check-[A-Za-z0-9._-]+\.(?:ts|sh))/g;
const MATRIX_CHECK_RE = /check:\s*\[([^\]]+)\]/g;

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1] as string);
}

/**
 * Extracts CI entry points from raw ci.yml text.
 *
 * Deliberately textual rather than a YAML parse: the matrix indirection
 * (`run: bun run ${{ matrix.check }}`) means a structural walk would still have
 * to resolve the expression by hand, and the workflow is ours to keep simple.
 */
export function parseCiEntryPoints(ciYaml: string): CiEntryPoints {
  const scriptNames = matchAll(ciYaml, BUN_RUN_RE).filter(
    (name) => !name.startsWith("$")
  );
  for (const list of matchAll(ciYaml, MATRIX_CHECK_RE)) {
    for (const entry of list.split(",")) {
      const name = entry.trim();
      if (name) scriptNames.push(name);
    }
  }
  return {
    scriptNames: [...new Set(scriptNames)],
    scriptFiles: [...new Set(matchAll(ciYaml, SCRIPT_FILE_RE))],
  };
}

export interface ReachabilityInputs {
  entryScriptNames: string[];
  entryScriptFiles: string[];
  packageScripts: Record<string, string>;
}

/**
 * Walks the entry points, following `bun run <name>` hops through
 * package.json, and returns every `scripts/check-*` file they reach.
 */
export function collectReachableScriptFiles(
  inputs: ReachabilityInputs
): Set<string> {
  const reached = new Set<string>(inputs.entryScriptFiles);
  const visited = new Set<string>();
  const queue = [...inputs.entryScriptNames];

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (visited.has(name)) continue;
    visited.add(name);

    const command = inputs.packageScripts[name];
    if (!command) continue;

    for (const file of matchAll(command, SCRIPT_FILE_RE)) reached.add(file);
    for (const next of matchAll(command, BUN_RUN_RE)) queue.push(next);
  }

  return reached;
}

export interface UnreachableInputs extends ReachabilityInputs {
  checkScripts: string[];
}

export function findUnreachableCheckScripts(
  inputs: UnreachableInputs
): string[] {
  const reachable = collectReachableScriptFiles(inputs);
  return inputs.checkScripts.filter((name) => !reachable.has(name)).sort();
}

/** Resolves every input from the repo on disk, then applies the rule. */
export function findUnreachableCheckScriptsInRepo(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const packageScripts = pkg.scripts ?? {};

  const ciPath = join(root, CI_WORKFLOW);
  const ci = existsSync(ciPath)
    ? parseCiEntryPoints(readFileSync(ciPath, "utf8"))
    : { scriptNames: [], scriptFiles: [] };

  return findUnreachableCheckScripts({
    checkScripts: discoverCheckScripts(root),
    entryScriptNames: ci.scriptNames,
    entryScriptFiles: ci.scriptFiles,
    packageScripts,
  });
}

function main() {
  const root = join(import.meta.dir, "..");
  const unreachable = findUnreachableCheckScriptsInRepo(root);

  if (unreachable.length > 0) {
    console.error(
      `[FAIL] ${unreachable.length} check script(s) run in no pipeline:`
    );
    for (const name of unreachable) console.error(`  - scripts/${name}`);
    console.error(
      `\nAdd each to the "check:all" script in package.json, or delete it.`
    );
    process.exit(1);
  }

  console.log(
    `OK: all ${discoverCheckScripts(root).length} check scripts are reachable from CI`
  );
}

if (import.meta.main) {
  main();
}
