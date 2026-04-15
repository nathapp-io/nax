/**
 * Tier 2 — Framework Defaults
 *
 * When no explicit framework config file is found (Tier 1), but a framework
 * is declared in the project manifest (package.json devDependencies, go.mod,
 * Cargo.toml, pyproject.toml), we use the framework's canonical default
 * test-file patterns.
 *
 * Returns null when no known framework manifest is found in the workdir.
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

/** Default patterns per JS/TS test framework */
const JS_FRAMEWORK_DEFAULTS: Record<string, readonly string[]> = {
  vitest: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  jest: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
  mocha: ["test/**/*.{js,mjs,cjs}", "**/*.spec.{js,ts}"],
  jasmine: ["spec/**/*.js"],
  "@playwright/test": ["**/*.spec.ts", "**/*.spec.js"],
  cypress: ["cypress/e2e/**/*.cy.{js,jsx,ts,tsx}"],
};

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
 * Parse package.json to detect JS/TS test framework from devDependencies.
 * Falls back to bun test heuristic when `bun test` appears in scripts.test.
 */
async function detectFromPackageJson(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/package.json`;
  const text = await _frameworkDefaultsDeps.readText(path);
  if (!text) return null;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const devDeps = (pkg.devDependencies as Record<string, unknown>) ?? {};
  const deps = (pkg.dependencies as Record<string, unknown>) ?? {};
  const allDeps = { ...deps, ...devDeps };

  // Check for known JS/TS frameworks (priority order)
  for (const [framework, patterns] of Object.entries(JS_FRAMEWORK_DEFAULTS)) {
    if (framework in allDeps) {
      return { type: "manifest", path, patterns: expandExtglobAll(patterns) };
    }
  }

  // Check for bun test in scripts.test
  const scripts = pkg.scripts as Record<string, unknown> | undefined;
  const testScript = typeof scripts?.test === "string" ? scripts.test : "";
  if (testScript.includes("bun test")) {
    return { type: "manifest", path, patterns: expandExtglobAll(BUN_TEST_DEFAULTS) };
  }

  return null;
}

/**
 * Detect Go projects from go.mod presence.
 */
async function detectFromGoMod(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/go.mod`;
  if (!(await _frameworkDefaultsDeps.fileExists(path))) return null;
  return { type: "manifest", path, patterns: ["**/*_test.go"] };
}

/**
 * Detect Rust projects from Cargo.toml presence.
 */
async function detectFromCargoToml(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/Cargo.toml`;
  if (!(await _frameworkDefaultsDeps.fileExists(path))) return null;
  return { type: "manifest", path, patterns: ["tests/**/*.rs", "src/**/*.rs"] };
}

/**
 * Detect Python projects from pyproject.toml (without pytest ini_options).
 * Covers projects that declare pytest as a test dependency but don't configure testpaths.
 */
async function detectFromPyprojectDeps(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/pyproject.toml`;
  const text = await _frameworkDefaultsDeps.readText(path);
  if (!text) return null;

  // Check for pytest in [project.dependencies] or [tool.poetry.dependencies]
  if (text.includes("pytest")) {
    return { type: "manifest", path, patterns: ["test_*.py", "*_test.py", "tests/**/*.py"] };
  }
  return null;
}

/**
 * Run all Tier 2 manifest-based detection for a workdir.
 * Returns an array of DetectionSources. Empty when no framework is found.
 */
export async function detectFromFrameworkDefaults(workdir: string): Promise<DetectionSource[]> {
  const results = await Promise.all([
    detectFromPackageJson(workdir),
    detectFromGoMod(workdir),
    detectFromCargoToml(workdir),
    detectFromPyprojectDeps(workdir),
  ]);

  return results.filter((r): r is DetectionSource => r !== null);
}
