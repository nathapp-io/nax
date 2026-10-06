#!/usr/bin/env bun
/**
 * Gate: the workspace package boundaries (S1 spec section 7). It replaced the
 * S1 move ratchet (check-agent-boundary), which is deleted along with the move
 * script that wrote it.
 *
 * - packages/nax-agent imports only node: builtins (Bun imports in tests only), its declared
 *   dependencies, `#src/` and `#test/`, relative paths that stay inside the
 *   package, and itself from test/ only (the packaging tests import the public
 *   entry by name). Never `@nathapp/nax`, never a tsconfig alias (`@/`).
 * - packages/nax-ai imports neither @nathapp/nax nor @nathapp/nax-agent.
 * - packages/nax reaches nax-agent only through `@nathapp/nax-agent` or
 *   `@nathapp/nax-agent/internal`, and never a nax-agent test helper (S2-1
 *   removed that export). It may import test-kit only from test/ and
 *   repo-tooling only from scripts/ and test/. Never a relative path into
 *   another package.
 * - packages/test-kit and packages/repo-tooling (private tooling) import no nax
 *   package; repo-tooling may use test-kit from its tests (a devDependency).
 * - packages/nax-agent-acp (S4 spec section 4) reaches nax-agent only through
 *   `@nathapp/nax-agent`, never `./internal` or a deep path, from src/ and test/
 *   alike. Its src/ imports only the ACP SDK root, the MCP SDK, zod and node:
 *   builtins. No other package imports it (nax adopts it in S4b).
 *
 * Scans src/, test/, bin/ and scripts/ of every package.
 *
 * Default-deny: a packages/* directory that has a package.json but no entry in
 * RULES is a hard failure, not a skip. A rule keyed on a package name that the
 * tree does not use would otherwise no-op silently and this gate would print
 * [OK] while enforcing nothing.
 *
 * Usage:
 *   bun scripts/check-package-boundaries.ts            # check the repo this script lives in
 *   bun scripts/check-package-boundaries.ts <repoRoot>  # check another tree (tests)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { byCodePoint } from "@nathapp/nax-agent/internal";
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
const TEST_KIT = "@nathapp/nax-test-kit";
const REPO_TOOLING = "@nathapp/nax-repo-tooling";
const ACP = "@nathapp/nax-agent-acp";
const ACP_SDK = "@agentclientprotocol/sdk";
const ACP_SRC_DEPS = new Set([ACP_SDK, "@modelcontextprotocol/sdk", "zod"]);
const NAX_PACKAGES = new Set(["@nathapp/nax", AGENT, "@nathapp/nax-ai", ACP, TEST_KIT, REPO_TOOLING]);

function inDir(pkg: PackageInfo, file: string, dir: string): boolean {
  return relative(pkg.dir, file).startsWith(`${dir}${sep}`);
}

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
  if ((spec === "bun" || spec.startsWith("bun:")) && !inDir(pkg, file, "test")) return "Bun import outside test/";
  if (isBuiltin(spec) || spec.startsWith("#src/") || spec.startsWith("#test/")) return null;
  if (spec.startsWith(".")) return leavesPackage(pkg, file, spec) ? "relative import leaves the package" : null;
  if (spec.startsWith("@/") || spec.startsWith("@test/") || spec.startsWith("@scripts/")) return "tsconfig alias";
  const name = packageName(spec);
  if (name === "@nathapp/nax") return "imports nax";
  if (name === ACP) return "nax-agent imports nax-agent-acp";
  if (name === AGENT) {
    // The packaging tests import the public entry by name; everything else must
    // use #src/ — the rule nax-agent's own context states (#2323 item 4).
    return inDir(pkg, file, "test")
      ? null
      : "self-import by package name; use #src/ (test/ may import the public entry)";
  }
  if (pkg.deps.has(name)) return null;
  const inTests = inDir(pkg, file, "test");
  if (pkg.devDeps.has(name)) return inTests ? null : `devDependency ${name} imported outside test/`;
  return `undeclared dependency ${name}`;
}

function naxAiViolation(_pkg: PackageInfo, _file: string, spec: string): string | null {
  const name = packageName(spec);
  return name === "@nathapp/nax" || name === AGENT || name === ACP ? `nax-ai imports ${name}` : null;
}

function naxViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  if (leavesPackage(pkg, file, spec)) return "relative import leaves the package";
  if (packageName(spec) === ACP) return "nax does not depend on nax-agent-acp until S4b";
  const name = packageName(spec);
  if (name === TEST_KIT) return inDir(pkg, file, "test") ? null : `${TEST_KIT} imported outside test/`;
  if (name === REPO_TOOLING) {
    return inDir(pkg, file, "test") || inDir(pkg, file, "scripts")
      ? null
      : `${REPO_TOOLING} imported outside scripts/ and test/`;
  }
  if (name !== AGENT || NAX_ALLOWED_AGENT_SPECS.has(spec)) return null;
  return `only ${[...NAX_ALLOWED_AGENT_SPECS].join(" or ")}`;
}

/** test-kit and repo-tooling: leaf packages that import no nax package (repo-tooling's tests may use test-kit). */
function toolingViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  if (isBuiltin(spec) || spec.startsWith("#")) return null;
  if (spec.startsWith(".")) return leavesPackage(pkg, file, spec) ? "relative import leaves the package" : null;
  const name = packageName(spec);
  if (name === pkg.name) return null;
  if (NAX_PACKAGES.has(name)) {
    if (pkg.name === REPO_TOOLING && name === TEST_KIT && pkg.devDeps.has(name) && inDir(pkg, file, "test"))
      return null;
    return `${pkg.name} imports ${name}`;
  }
  if (pkg.devDeps.has(name)) return inDir(pkg, file, "test") ? null : `devDependency ${name} imported outside test/`;
  if (pkg.deps.has(name)) return null;
  return `undeclared dependency ${name}`;
}

/** acp's dependency tail: devDependencies are test/- and scripts/-only, and src/ has a strict allowlist. */
function acpDependencyViolation(pkg: PackageInfo, file: string, name: string, inTests: boolean): string | null {
  if (pkg.devDeps.has(name) && !pkg.deps.has(name)) {
    return inTests || inDir(pkg, file, "scripts") ? null : `devDependency ${name} imported outside test/`;
  }
  if (!pkg.deps.has(name)) return `undeclared dependency ${name}`;
  if (!inTests && inDir(pkg, file, "src") && !ACP_SRC_DEPS.has(name)) {
    return `nax-agent-acp src/ may import only ${[...ACP_SRC_DEPS].join(", ")}`;
  }
  return null;
}

function acpViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  const inTests = inDir(pkg, file, "test");
  if ((spec === "bun" || spec.startsWith("bun:")) && !inTests) return "Bun import outside test/";
  if (isBuiltin(spec) || spec.startsWith("#src/") || spec.startsWith("#test/")) return null;
  if (spec.startsWith(".")) return leavesPackage(pkg, file, spec) ? "relative import leaves the package" : null;
  const name = packageName(spec);
  if (name === pkg.name) return null;
  if (name === AGENT) return spec === AGENT ? null : `only ${AGENT} (never ./internal or a deep path)`;
  if (name === "@nathapp/nax") return "imports nax";
  if (name === "@nathapp/nax-ai") return `imports nax-ai (reach it through ${AGENT})`;
  if (name === ACP_SDK && spec !== ACP_SDK) return `only the ${ACP_SDK} root`;
  return acpDependencyViolation(pkg, file, name, inTests);
}

type Rule = (pkg: PackageInfo, file: string, spec: string) => string | null;

const RULES: Readonly<Record<string, Rule>> = {
  "@nathapp/nax-agent": agentViolation,
  "@nathapp/nax-ai": naxAiViolation,
  "@nathapp/nax": naxViolation,
  [TEST_KIT]: toolingViolation,
  [REPO_TOOLING]: toolingViolation,
  [ACP]: acpViolation,
};

/**
 * Throws if any package in the tree has no rule. Skipping one would let a
 * misnamed package.json (or a package added before its rule exists) report
 * green with that package entirely unenforced.
 */
function assertEveryPackageEnforced(unenforced: readonly string[]): void {
  if (unenforced.length === 0) return;
  throw new Error(
    `check-package-boundaries: no boundary rule for these packages, so the gate cannot enforce them: ${unenforced.join(", ")}. Add each name to RULES.`,
  );
}

export function findBoundaryViolations(repoRoot: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const unenforced: string[] = [];
  const packagesDir = join(repoRoot, "packages");
  for (const entry of readdirSync(packagesDir).sort(byCodePoint)) {
    const dir = join(packagesDir, entry);
    if (!existsSync(join(dir, "package.json"))) continue;
    const pkg = loadPackage(dir);
    const rule = RULES[pkg.name];
    if (rule === undefined) {
      unenforced.push(pkg.name);
      continue;
    }
    for (const file of SCAN_DIRS.flatMap((d) => codeFiles(join(dir, d)))) {
      for (const site of specifierSites(readFileSync(file, "utf8"))) {
        const why = rule(pkg, file, site.spec);
        if (why !== null) violations.push({ file: relative(repoRoot, file), spec: site.spec, why });
      }
    }
  }
  assertEveryPackageEnforced(unenforced);
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
