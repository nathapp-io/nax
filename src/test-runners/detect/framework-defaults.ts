/**
 * Tier 2 — Framework Defaults
 *
 * When no explicit framework config file is found (Tier 1), but a framework
 * is declared in the project manifest (package.json devDependencies, go.mod,
 * Cargo.toml, pyproject.toml), we use the framework's canonical default
 * test-file patterns.
 *
 * Returns null when no known framework manifest is found in the workdir.
 *
 * Multi-framework projects (e.g. jest + @playwright/test) are fully supported:
 * all matching frameworks emit their defaults, not just the first one found.
 */

import { expandExtglobAll } from "./extglob";
import type { DetectionSource } from "./types";

/** Injectable deps for testability */
export const _frameworkDefaultsDeps = {
  readText: async (path: string): Promise<string | null> => {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return f.text();
  },
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
};

/**
 * Default patterns per JS/TS test framework.
 *
 * `depKey` is the npm package name used to look up in package.json dependencies.
 * `framework` is the canonical framework identifier used for Tier 1/2 isolation —
 * these must match what the Tier 1 parsers in framework-configs.ts emit.
 */
const JS_FRAMEWORK_DEFAULTS: Array<{ depKey: string; framework: string; patterns: readonly string[] }> = [
  { depKey: "vitest", framework: "vitest", patterns: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"] },
  {
    depKey: "jest",
    framework: "jest",
    patterns: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
  },
  { depKey: "mocha", framework: "mocha", patterns: ["test/**/*.{js,mjs,cjs}", "**/*.spec.{js,ts}"] },
  { depKey: "jasmine", framework: "jasmine", patterns: ["spec/**/*.js"] },
  // Note: depKey is "@playwright/test" but framework name is "playwright" to match Tier 1 parser.
  { depKey: "@playwright/test", framework: "playwright", patterns: ["**/*.spec.ts", "**/*.spec.js"] },
  { depKey: "cypress", framework: "cypress", patterns: ["cypress/e2e/**/*.cy.{js,jsx,ts,tsx}"] },
];

/**
 * Bun test defaults — matches Bun's hardcoded discovery rules
 * (*.test.*, *_test.*, *.spec.*, *_spec.* across all JS/TS extensions).
 * Activated when `bun test` appears in package.json#scripts.test.
 */
const BUN_TEST_DEFAULTS: readonly string[] = [
  "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*_test.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*_spec.{ts,tsx,js,jsx,mjs,cjs}",
];

/**
 * Parse package.json to detect ALL declared JS/TS test frameworks.
 *
 * Returns one DetectionSource per framework found in devDependencies/dependencies.
 * Previously this returned only the first matching framework — now all are emitted
 * so projects using e.g. jest (unit) + @playwright/test (e2e) get both.
 */
async function detectFromPackageJson(workdir: string): Promise<DetectionSource[]> {
  const path = `${workdir}/package.json`;
  const text = await _frameworkDefaultsDeps.readText(path);
  if (!text) return [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }

  const devDeps = (pkg.devDependencies as Record<string, unknown>) ?? {};
  const deps = (pkg.dependencies as Record<string, unknown>) ?? {};
  const allDeps = { ...deps, ...devDeps };

  // Collect a source for every JS/TS framework found (all of them, not just first)
  const results: DetectionSource[] = [];
  for (const { depKey, framework, patterns } of JS_FRAMEWORK_DEFAULTS) {
    if (depKey in allDeps) {
      results.push({ type: "manifest", framework, path, patterns: expandExtglobAll(patterns) });
    }
  }

  if (results.length > 0) return results;

  // No recognised framework — check for bun test in scripts.test
  const scripts = pkg.scripts as Record<string, unknown> | undefined;
  const testScript = typeof scripts?.test === "string" ? scripts.test : "";
  if (testScript.includes("bun test")) {
    return [{ type: "manifest", framework: "bun", path, patterns: expandExtglobAll(BUN_TEST_DEFAULTS) }];
  }

  return [];
}

/**
 * Detect Go projects from go.mod presence.
 */
async function detectFromGoMod(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/go.mod`;
  if (!(await _frameworkDefaultsDeps.fileExists(path))) return null;
  return { type: "manifest", framework: "go", path, patterns: ["**/*_test.go"] };
}

/**
 * Detect Rust projects from Cargo.toml presence.
 */
async function detectFromCargoToml(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/Cargo.toml`;
  if (!(await _frameworkDefaultsDeps.fileExists(path))) return null;
  return { type: "manifest", framework: "rust", path, patterns: ["tests/**/*.rs", "src/**/*.rs"] };
}

/**
 * Detect Python/pytest projects from pyproject.toml dependencies.
 *
 * This is the Tier 2 fallback for when no [tool.pytest.ini_options] section
 * exists (which would be caught by Tier 1 parsePyprojectToml).
 *
 * Heuristic: look for `pytest` as a package name in dependency value strings
 * or as an unquoted TOML key followed by a version specifier.
 * This avoids false positives from comments or [tool.pytest.*] config sections.
 */
async function detectFromPyprojectDeps(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/pyproject.toml`;
  const text = await _frameworkDefaultsDeps.readText(path);
  if (!text) return null;

  // Match pytest as a dependency declaration:
  //   - line-start key:   `pytest = ">=7"` or `  pytest>=7`
  //   - quoted string:    `"pytest"`, `"pytest>=7"`, `'pytest~=7.0'`
  // Does NOT match plugin packages such as `pytest-cov`, `pytest-asyncio` (the
  // negative lookahead (?![-\w]) rejects any continuation with a dash or word char).
  // Does NOT match `[tool.pytest.ini_options]` (preceded by `.`, no = or quotes).
  const PYTEST_DEP_RE = /(?:^[ \t]*["']?pytest(?![-\w]))|(?:["']pytest(?![-\w])(?:[>=~!<][^"']*)?["'])/m;
  if (!PYTEST_DEP_RE.test(text)) return null;

  return {
    type: "manifest",
    framework: "pytest",
    path,
    patterns: ["test_*.py", "*_test.py", "tests/**/*.py"],
  };
}

/**
 * Run all Tier 2 manifest-based detection for a workdir.
 * Returns an array of DetectionSources. Empty when no framework is found.
 */
export async function detectFromFrameworkDefaults(workdir: string): Promise<DetectionSource[]> {
  const [pkgJsonSources, goSource, cargoSource, pyprojectSource] = await Promise.all([
    detectFromPackageJson(workdir),
    detectFromGoMod(workdir),
    detectFromCargoToml(workdir),
    detectFromPyprojectDeps(workdir),
  ]);

  return [
    ...pkgJsonSources,
    ...(goSource ? [goSource] : []),
    ...(cargoSource ? [cargoSource] : []),
    ...(pyprojectSource ? [pyprojectSource] : []),
  ];
}
