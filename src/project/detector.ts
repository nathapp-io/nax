/**
 * Project profile auto-detection (US-002)
 *
 * Detects language, type, testFramework, and lintTool from manifest files.
 * Only detects fields not already set in the `existing` partial.
 */

import { join } from "node:path";
import type { ProjectProfile } from "../config";

// ── Dependency injection ──────────────────────────────────────────────────────

export const _detectorDeps = {
  async fileExists(path: string): Promise<boolean> {
    const file = Bun.file(path);
    return file.exists();
  },
  async readJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      const text = await file.text();
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
};

// ── Manifest file names ───────────────────────────────────────────────────────

const WEB_DEPS = new Set(["react", "next", "vue", "nuxt"]);
const API_DEPS = new Set(["express", "fastify", "hono"]);

// ── Language detection ────────────────────────────────────────────────────────

async function _detectLanguageImpl(
  workdir: string,
  pkg: Record<string, unknown> | null,
): Promise<ProjectProfile["language"] | undefined> {
  const deps = _detectorDeps;

  if (await deps.fileExists(join(workdir, "go.mod"))) return "go";
  if (await deps.fileExists(join(workdir, "Cargo.toml"))) return "rust";
  if (await deps.fileExists(join(workdir, "pyproject.toml"))) return "python";
  if (await deps.fileExists(join(workdir, "requirements.txt"))) return "python";

  if (pkg != null) {
    const allDeps = {
      ...(pkg.dependencies as Record<string, unknown> | undefined),
      ...(pkg.devDependencies as Record<string, unknown> | undefined),
    };
    if ("typescript" in allDeps) return "typescript";
    return "javascript";
  }

  return undefined;
}

// ── Type detection ────────────────────────────────────────────────────────────

function detectType(pkg: Record<string, unknown> | null): ProjectProfile["type"] | undefined {
  if (pkg == null) return undefined;

  if (pkg.workspaces != null) return "monorepo";

  const allDeps = {
    ...(pkg.dependencies as Record<string, unknown> | undefined),
    ...(pkg.devDependencies as Record<string, unknown> | undefined),
  };

  for (const dep of WEB_DEPS) {
    if (dep in allDeps) return "web";
  }

  if ("ink" in allDeps) return "tui";

  for (const dep of API_DEPS) {
    if (dep in allDeps) return "api";
  }

  if (pkg.bin != null) return "cli";

  return undefined;
}

// ── testFramework inference ───────────────────────────────────────────────────

async function detectTestFramework(
  _workdir: string,
  language: ProjectProfile["language"] | undefined,
  pkg: Record<string, unknown> | null,
): Promise<string | undefined> {
  if (language === "go") return "go-test";
  if (language === "rust") return "cargo-test";
  if (language === "python") return "pytest";

  if (pkg != null) {
    const devDeps = (pkg.devDependencies as Record<string, unknown> | undefined) ?? {};
    if ("vitest" in devDeps) return "vitest";
    if ("jest" in devDeps) return "jest";
  }

  return undefined;
}

// ── Language Detection Memo ───────────────────────────────────────────────────

const _languageCache = new Map<string, ProjectProfile["language"] | undefined>();

/** Clear the language-detection memo. Call in test teardown for isolation. */
export function clearLanguageCache(): void {
  _languageCache.clear();
}

// ── Public API (Language Detection) ───────────────────────────────────────────

/**
 * Detect the language of a package directory (memoized per process).
 *
 * Detection priority: Go > Rust > Python > TypeScript > JavaScript.
 * Returns `undefined` if no language markers are found.
 * Call `clearLanguageCache()` in test teardown to reset the memo.
 */
export async function detectLanguage(packageDir: string): Promise<ProjectProfile["language"] | undefined> {
  if (_languageCache.has(packageDir)) return _languageCache.get(packageDir);
  const pkg = await _detectorDeps.readJson(join(packageDir, "package.json"));
  const result = await _detectLanguageImpl(packageDir, pkg);
  _languageCache.set(packageDir, result);
  return result;
}

// ── lintTool inference ────────────────────────────────────────────────────────

async function detectLintTool(
  workdir: string,
  language: ProjectProfile["language"] | undefined,
): Promise<string | undefined> {
  if (language === "go") return "golangci-lint";
  if (language === "rust") return "clippy";
  if (language === "python") return "ruff";

  const deps = _detectorDeps;
  if (await deps.fileExists(join(workdir, "biome.json"))) return "biome";
  if (await deps.fileExists(join(workdir, ".eslintrc"))) return "eslint";
  if (await deps.fileExists(join(workdir, ".eslintrc.js"))) return "eslint";
  if (await deps.fileExists(join(workdir, ".eslintrc.json"))) return "eslint";

  return undefined;
}

// ── Public API (Project Profile) ──────────────────────────────────────────────

/**
 * Detect project profile fields not already set in `existing`.
 * Detection priority: Go > Rust > Python > Node/Bun.
 */
export async function detectProjectProfile(
  workdir: string,
  existing: Partial<ProjectProfile>,
): Promise<ProjectProfile> {
  const pkg = await _detectorDeps.readJson(join(workdir, "package.json"));

  const language = existing.language !== undefined ? existing.language : await _detectLanguageImpl(workdir, pkg);

  const type = existing.type !== undefined ? existing.type : detectType(pkg);

  const testFramework =
    existing.testFramework !== undefined ? existing.testFramework : await detectTestFramework(workdir, language, pkg);

  const lintTool = existing.lintTool !== undefined ? existing.lintTool : await detectLintTool(workdir, language);

  return { language, type, testFramework, lintTool };
}
