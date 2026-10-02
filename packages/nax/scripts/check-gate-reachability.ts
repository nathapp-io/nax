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
 *   2. `.github/workflows/ci.yml` at the repo root — every `run:` step, plus
 *      the `check:` build matrix, expanded the same way.
 *
 * Usage:
 *   bun scripts/check-gate-reachability.ts
 *
 * Exit codes:
 *   0 — every check script is reachable
 *   1 — one or more check scripts are unreachable (listed on stderr)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { findRepoRoot } from "./lib/repo-root";

const CI_WORKFLOW = join(".github", "workflows", "ci.yml");

/** A check script is any `scripts/check-*.ts` or `scripts/check-*.sh`. */
export function discoverCheckScripts(root: string): string[] {
  const dir = join(root, "scripts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("check-") && (name.endsWith(".ts") || name.endsWith(".sh")));
}

export interface CiEntryPoints {
  /** package.json script names CI invokes, e.g. "lint", "check:all". */
  scriptNames: string[];
  /** scripts/ files CI invokes directly, e.g. "check-process-cwd.sh". */
  scriptFiles: string[];
}

const BUN_RUN_RE = /bun\s+run\s+(?:--\S+\s+)*([A-Za-z0-9:_-]+)/g;
const SCRIPT_FILE_RE = /scripts\/(check-[A-Za-z0-9._-]+\.(?:ts|sh))/g;
const SCRIPT_PATH_RE =
  /(?:^|[\s"'`])((?:(?:\.\.?\/)|(?:[A-Za-z0-9_.-]+\/))*scripts\/check-[A-Za-z0-9._-]+\.(?:ts|sh))(?=$|[\s"'`])/g;

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1] as string);
}

/**
 * Extracts CI entry points from raw ci.yml text.
 *
 * Workflow runs are read structurally so matrix entries and effective working
 * directories stay attached to the job and step that execute them.
 */
export function parseCiEntryPoints(ciYaml: string): CiEntryPoints {
  const runs = workflowRuns(ciYaml).flatMap(({ run }) => run);
  const scriptNames = runs.flatMap((run) => matchAll(run, BUN_RUN_RE).filter((name) => !name.startsWith("$")));
  return {
    scriptNames: [...new Set(scriptNames)],
    scriptFiles: [...new Set(runs.flatMap((run) => matchAll(run, SCRIPT_FILE_RE)))],
  };
}

interface WorkflowRun {
  readonly run: string[];
  readonly workingDirectory: string;
}

interface MatrixValue {
  readonly [key: string]: string;
}

interface WorkflowStep {
  readonly run?: unknown;
  readonly "working-directory"?: unknown;
}

interface WorkflowDefaults {
  readonly run?: { readonly "working-directory"?: unknown };
}

interface WorkflowJob {
  readonly defaults?: WorkflowDefaults;
  readonly strategy?: { readonly matrix?: Record<string, unknown> };
  readonly steps?: WorkflowStep[];
}

interface WorkflowDocument {
  readonly defaults?: WorkflowDefaults;
  readonly jobs?: Record<string, WorkflowJob>;
}

function matrixValues(job: WorkflowJob): MatrixValue[] {
  const entries = Object.entries(job.strategy?.matrix ?? {}).filter(
    ([name, value]) => name !== "include" && name !== "exclude" && Array.isArray(value),
  );
  if (entries.length === 0) return [{}];
  return entries.reduce<MatrixValue[]>(
    (sets, [name, rawValues]) => {
      const values = (rawValues as unknown[])
        .filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        .map(String);
      return sets.flatMap((set) => values.map((value) => ({ ...set, [name]: value })));
    },
    [{}],
  );
}

function expandMatrixRun(run: string, values: MatrixValue[]): string[] {
  const matrixExpression = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g;
  const names = [...run.matchAll(matrixExpression)].map((match) => match[1] as string);
  return values.map((value) => {
    for (const name of names) {
      if (value[name] === undefined) {
        throw new Error(
          `check-gate-reachability: CI run references matrix.${name}, but its job has no scalar matrix values for that key`,
        );
      }
    }
    return run.replace(matrixExpression, (_match, name: string) => value[name] ?? "");
  });
}

/** Reads the workflow structure so run commands retain their job/step cwd and matrix context. */
function workflowRuns(ciYaml: string): WorkflowRun[] {
  const workflow = (Bun.YAML.parse(ciYaml) ?? {}) as WorkflowDocument;
  const runs: WorkflowRun[] = [];
  for (const job of Object.values(workflow.jobs ?? {})) {
    const jobDirectory =
      typeof job.defaults?.run?.["working-directory"] === "string"
        ? job.defaults.run["working-directory"]
        : typeof workflow.defaults?.run?.["working-directory"] === "string"
          ? workflow.defaults.run["working-directory"]
          : ".";
    const matrix = matrixValues(job);
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") continue;
      const workingDirectory = typeof step["working-directory"] === "string" ? step["working-directory"] : jobDirectory;
      runs.push({ run: expandMatrixRun(step.run, matrix), workingDirectory });
    }
  }
  return runs;
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
export function collectReachableScriptFiles(inputs: ReachabilityInputs): Set<string> {
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

export function findUnreachableCheckScripts(inputs: UnreachableInputs): string[] {
  const reachable = collectReachableScriptFiles(inputs);
  return inputs.checkScripts.filter((name) => !reachable.has(name)).sort(byCodePoint);
}

const TOOLING_DIR = join("packages", "repo-tooling");

function readScripts(dir: string): Record<string, string> {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return {};
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

function packageRootFor(dir: string, repoRoot: string): string | null {
  let current = resolve(dir);
  const root = resolve(repoRoot);
  while (current === root || current.startsWith(`${root}${sep}`)) {
    if (existsSync(join(current, "package.json"))) return current;
    if (current === root) break;
    current = resolve(current, "..");
  }
  return null;
}

function collectReachablePaths(packageRoot: string, scriptNames: string[], directPaths: string[]): Set<string> {
  const reached = new Set(directPaths);
  const visited = new Set<string>();
  const queue = [...scriptNames];
  const scripts = readScripts(packageRoot);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (visited.has(name)) continue;
    visited.add(name);
    const command = scripts[name];
    if (!command) continue;
    for (const match of command.matchAll(SCRIPT_PATH_RE)) {
      const path = match[1];
      if (path !== undefined) reached.add(resolve(packageRoot, path));
    }
    queue.push(...matchAll(command, BUN_RUN_RE));
  }
  return reached;
}

/** Resolves every input from the repo on disk, then applies the rule.
 *  The checked scripts are `packageRoot/scripts` plus repo-tooling's (S2-0).
 *  CI run commands are resolved only against the package in that job/step's
 *  working directory, and scripts are compared by resolved path. */
export function findUnreachableCheckScriptsInRepo(packageRoot: string, repoRoot: string): string[] {
  const ciPath = join(repoRoot, CI_WORKFLOW);
  const runs = existsSync(ciPath) ? workflowRuns(readFileSync(ciPath, "utf8")) : [];
  const reached = new Set<string>();
  for (const invocation of runs) {
    const workingDir = resolve(repoRoot, invocation.workingDirectory);
    if (
      isAbsolute(invocation.workingDirectory) ||
      !(workingDir === resolve(repoRoot) || workingDir.startsWith(`${resolve(repoRoot)}${sep}`))
    ) {
      throw new Error(
        `check-gate-reachability: CI working-directory must stay inside the repository: ${invocation.workingDirectory}`,
      );
    }
    const cwdPackage = packageRootFor(workingDir, repoRoot);
    if (!cwdPackage) continue;
    const scriptNames = invocation.run.flatMap((run) =>
      matchAll(run, BUN_RUN_RE).filter((name) => !name.startsWith("$")),
    );
    const directPaths = invocation.run.flatMap((run) =>
      [...run.matchAll(SCRIPT_PATH_RE)].map((match) => resolve(workingDir, match[1] as string)),
    );
    for (const file of collectReachablePaths(cwdPackage, scriptNames, directPaths)) reached.add(file);
  }

  const checkScripts = [packageRoot, join(repoRoot, TOOLING_DIR)].flatMap((root) =>
    discoverCheckScripts(root).map((name) => join(root, "scripts", name)),
  );
  const basenameCounts = new Map<string, number>();
  for (const file of checkScripts) {
    const name = file.slice(file.lastIndexOf(sep) + 1);
    basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
  }
  return checkScripts
    .filter((file) => !reached.has(resolve(file)))
    .map((file) => {
      const name = file.slice(file.lastIndexOf(sep) + 1);
      return (basenameCounts.get(name) ?? 0) > 1 ? relative(repoRoot, file).split(sep).join("/") : name;
    })
    .sort(byCodePoint);
}

function main() {
  const packageRoot = join(import.meta.dir, "..");
  const unreachable = findUnreachableCheckScriptsInRepo(packageRoot, findRepoRoot(packageRoot));

  if (unreachable.length > 0) {
    console.error(`[FAIL] ${unreachable.length} check script(s) run in no pipeline:`);
    for (const name of unreachable) console.error(`  - ${name.includes("/") ? name : `scripts/${name}`}`);
    console.error(`\nAdd each to the "check:all" script in package.json, or delete it.`);
    process.exit(1);
  }

  const total = [packageRoot, join(findRepoRoot(packageRoot), TOOLING_DIR)].reduce(
    (count, root) => count + discoverCheckScripts(root).length,
    0,
  );
  console.log(`OK: all ${total} check scripts are reachable from CI`);
}

if (import.meta.main) {
  main();
}
