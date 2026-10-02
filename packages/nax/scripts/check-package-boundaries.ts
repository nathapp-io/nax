#!/usr/bin/env bun
/**
 * Gate: the workspace package boundaries (S1 spec section 7). Replaces the S1
 * move ratchet (check-agent-boundary) once nax-agent is a package.
 *
 * - packages/nax-agent imports only node:/bun builtins, its declared
 *   dependencies, `#src/` and `#test/`, relative paths that stay inside the
 *   package, and itself. Never `@nathapp/nax`, never a tsconfig alias (`@/`).
 * - packages/nax-ai imports neither @nathapp/nax nor @nathapp/nax-agent.
 * - packages/nax reaches nax-agent only through `@nathapp/nax-agent` or
 *   `@nathapp/nax-agent/internal`, plus `@nathapp/nax-agent/test/helpers/*`
 *   from its own tests. Never a relative path into another package.
 *
 * Scans src/, test/, bin/ and scripts/ of every package.
 *
 * Usage:
 *   bun scripts/check-package-boundaries.ts            # check the repo this script lives in
 *   bun scripts/check-package-boundaries.ts <repoRoot>  # check another tree (tests)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { byCodePoint } from "../src/utils/sort";
import { specifierSites } from "./lib/import-specifiers";
import { findRepoRoot } from "./lib/repo-root";

export interface BoundaryViolation {
  readonly file: string;
  readonly spec: string;
  readonly why: string;
}

interface PackageInfo {
  readonly dir: string;
  readonly name: string;
  /** Runtime dependencies: importable from anywhere in the package. */
  readonly deps: ReadonlySet<string>;
  /** devDependencies: importable from test/ only (nax bundles src/, so src/ may need only what nax ships). */
  readonly devDeps: ReadonlySet<string>;
}

const CODE = /\.(?:ts|tsx|mts|cts)$/;
const SCAN_DIRS = ["src", "test", "bin", "scripts"];
const AGENT = "@nathapp/nax-agent";
const NAX_ALLOWED_AGENT_SPECS = new Set([AGENT, `${AGENT}/internal`]);
const NAX_TEST_HELPERS = `${AGENT}/test/helpers/`;

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

function codeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return codeFiles(full);
    return CODE.test(name) ? [full] : [];
  });
}

function loadPackage(dir: string): PackageInfo {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return {
    dir,
    name: pkg.name,
    deps: new Set(Object.keys(pkg.dependencies ?? {})),
    devDeps: new Set(Object.keys(pkg.devDependencies ?? {})),
  };
}

function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:");
}

function leavesPackage(pkg: PackageInfo, file: string, spec: string): boolean {
  if (!spec.startsWith(".")) return false;
  const rel = relative(pkg.dir, resolve(dirname(file), spec));
  return rel === ".." || rel.startsWith(`..${sep}`);
}

function agentViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  if (isBuiltin(spec) || spec.startsWith("#src/") || spec.startsWith("#test/")) return null;
  if (spec.startsWith(".")) return leavesPackage(pkg, file, spec) ? "relative import leaves the package" : null;
  if (spec.startsWith("@/") || spec.startsWith("@test/") || spec.startsWith("@scripts/")) return "tsconfig alias";
  const name = packageName(spec);
  if (name === "@nathapp/nax") return "imports nax";
  if (name === AGENT || pkg.deps.has(name)) return null;
  const inTests = relative(pkg.dir, file).startsWith(`test${sep}`);
  if (pkg.devDeps.has(name)) return inTests ? null : `devDependency ${name} imported outside test/`;
  return `undeclared dependency ${name}`;
}

function naxAiViolation(_pkg: PackageInfo, _file: string, spec: string): string | null {
  const name = packageName(spec);
  return name === "@nathapp/nax" || name === AGENT ? `nax-ai imports ${name}` : null;
}

function naxViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  if (leavesPackage(pkg, file, spec)) return "relative import leaves the package";
  if (packageName(spec) !== AGENT || NAX_ALLOWED_AGENT_SPECS.has(spec)) return null;
  const inTests = relative(pkg.dir, file).startsWith(`test${sep}`);
  if (inTests && spec.startsWith(NAX_TEST_HELPERS)) return null;
  return `only ${[...NAX_ALLOWED_AGENT_SPECS].join(" or ")} (and ${NAX_TEST_HELPERS}* from test/)`;
}

type Rule = (pkg: PackageInfo, file: string, spec: string) => string | null;

const RULES: Readonly<Record<string, Rule>> = {
  "@nathapp/nax-agent": agentViolation,
  "@nathapp/nax-ai": naxAiViolation,
  "@nathapp/nax": naxViolation,
};

export function findBoundaryViolations(repoRoot: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const packagesDir = join(repoRoot, "packages");
  for (const entry of readdirSync(packagesDir).sort(byCodePoint)) {
    const dir = join(packagesDir, entry);
    if (!existsSync(join(dir, "package.json"))) continue;
    const pkg = loadPackage(dir);
    const rule = RULES[pkg.name];
    if (rule === undefined) continue;
    for (const file of SCAN_DIRS.flatMap((d) => codeFiles(join(dir, d)))) {
      for (const site of specifierSites(readFileSync(file, "utf8"))) {
        const why = rule(pkg, file, site.spec);
        if (why !== null) violations.push({ file: relative(repoRoot, file), spec: site.spec, why });
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const root = process.argv[2] ?? findRepoRoot(import.meta.dir);
  const violations = findBoundaryViolations(root);
  if (violations.length > 0) {
    console.error(`[FAIL] ${violations.length} package-boundary violation(s):`);
    for (const v of violations) console.error(`  ${v.file}: "${v.spec}" -- ${v.why}`);
    process.exit(1);
  }
  console.log("[OK] package boundaries hold");
}
