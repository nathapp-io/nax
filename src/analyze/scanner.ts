/**
 * Codebase Scanner
 *
 * Scans the project directory to generate a summary for LLM classification.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { discoverWorkspacePackages } from "../context/generator";
import { getSafeLogger } from "../logger";
import { detectLanguage } from "../project";
import type { CodebaseScan, SourceRoot } from "./types";

// ── Framework / test-runner patterns (inlined to avoid src/cli/ import) ──────

const FRAMEWORK_PATTERNS: [RegExp, string][] = [
  [/\bnext\b/, "Next.js"],
  [/\bnuxt\b/, "Nuxt"],
  [/\bremix\b/, "Remix"],
  [/\bexpress\b/, "Express"],
  [/\bfastify\b/, "Fastify"],
  [/\bhono\b/, "Hono"],
  [/\bnestjs|@nestjs\b/, "NestJS"],
  [/\breact\b/, "React"],
  [/\bvue\b/, "Vue"],
  [/\bsvelte\b/, "Svelte"],
  [/\bastro\b/, "Astro"],
  [/\belectron\b/, "Electron"],
];

const TEST_RUNNER_PATTERNS: [RegExp, string][] = [
  [/\bvitest\b/, "vitest"],
  [/\bjest\b/, "jest"],
  [/\bmocha\b/, "mocha"],
  [/\bava\b/, "ava"],
];

const MAX_SOURCE_ROOTS = 30;

// ── Injectable deps ───────────────────────────────────────────────────────────

export const _scannerDeps = {
  discoverWorkspacePackages: (workdir: string): Promise<string[]> => discoverWorkspacePackages(workdir),
  detectLanguage: (pkgDir: string): Promise<SourceRoot["language"]> =>
    detectLanguage(pkgDir) as Promise<SourceRoot["language"]>,
  readPackageJson: async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      return (await file.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
  logger: (): ReturnType<typeof getSafeLogger> => getSafeLogger(),
};

// ── Private helpers ───────────────────────────────────────────────────────────

function resolveFrameworkAndRunner(
  language: SourceRoot["language"],
  pkg: Record<string, unknown> | null,
): { framework: string; testRunner: string } {
  if (language === "go") return { framework: "", testRunner: "go-test" };
  if (language === "python") return { framework: "", testRunner: "pytest" };
  if (language === "rust") return { framework: "", testRunner: "cargo-test" };

  if (!pkg) return { framework: "", testRunner: "" };

  const allDeps = {
    ...(pkg.dependencies as Record<string, unknown> | undefined),
    ...(pkg.devDependencies as Record<string, unknown> | undefined),
  };
  const depNames = Object.keys(allDeps).join(" ");
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const testScript = scripts.test ?? "";

  const framework = FRAMEWORK_PATTERNS.find(([re]) => re.test(depNames))?.[1] ?? "";
  const testRunner =
    TEST_RUNNER_PATTERNS.find(([re]) => re.test(depNames))?.[1] ?? (testScript.includes("bun test") ? "bun:test" : "");

  return { framework, testRunner };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan source roots in the given workdir.
 *
 * Discovers workspace packages via discoverWorkspacePackages, then resolves
 * language, framework, and test runner for each root. Falls back to a single
 * root at "." when no workspace packages are found or discovery fails.
 */
export async function scanSourceRoots(workdir: string): Promise<SourceRoot[]> {
  const deps = _scannerDeps;

  let packages: string[];

  try {
    packages = await deps.discoverWorkspacePackages(workdir);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.logger()?.warn("analyze", "discoverWorkspacePackages failed, using single-package fallback", {
      error: errMsg,
    });
    try {
      const language = await deps.detectLanguage(workdir);
      const pkg = await deps.readPackageJson(join(workdir, "package.json"));
      const { framework, testRunner } = resolveFrameworkAndRunner(language, pkg);
      return [{ path: ".", language, framework, testRunner }];
    } catch {
      return [{ path: ".", language: undefined, framework: "", testRunner: "" }];
    }
  }

  if (packages.length === 0) {
    packages = ["."];
  }

  if (packages.length > MAX_SOURCE_ROOTS) {
    deps.logger()?.warn("analyze", "Workspace package count exceeds limit, truncating", {
      count: packages.length,
      truncatedTo: MAX_SOURCE_ROOTS,
    });
    packages = packages.slice(0, MAX_SOURCE_ROOTS);
  }

  return Promise.all(
    packages.map(async (pkgPath): Promise<SourceRoot> => {
      const pkgDir = pkgPath === "." ? workdir : join(workdir, pkgPath);
      const language = await deps.detectLanguage(pkgDir);
      const pkg = await deps.readPackageJson(join(pkgDir, "package.json"));
      const { framework, testRunner } = resolveFrameworkAndRunner(language, pkg);
      return { path: pkgPath, language, framework, testRunner };
    }),
  );
}

/**
 * Scan codebase to generate summary for LLM classification.
 *
 * Generates:
 * - File tree (src/ directory, max depth 3)
 * - Package.json dependencies
 * - Test pattern detection
 *
 * @param workdir - Project root directory
 * @returns Codebase scan result
 *
 * @example
 * ```ts
 * const scan = await scanCodebase("/path/to/project");
 * console.log(scan.fileTree);
 * console.log(scan.dependencies);
 * ```
 */
export async function scanCodebase(workdir: string): Promise<CodebaseScan> {
  const srcPath = join(workdir, "src");
  const packageJsonPath = join(workdir, "package.json");

  // Generate file tree (src/ only, max depth 3)
  const fileTree = existsSync(srcPath) ? await generateFileTree(srcPath, 3) : "No src/ directory";

  // Extract dependencies from package.json
  let dependencies: Record<string, string> = {};
  let devDependencies: Record<string, string> = {};

  if (existsSync(packageJsonPath)) {
    try {
      const pkg = await Bun.file(packageJsonPath).json();
      dependencies = pkg.dependencies || {};
      devDependencies = pkg.devDependencies || {};
    } catch {
      // Invalid package.json, use empty deps
    }
  }

  // Detect test patterns
  const testPatterns = detectTestPatterns(workdir, dependencies, devDependencies);

  return {
    fileTree,
    dependencies,
    devDependencies,
    testPatterns,
  };
}

/**
 * Generate file tree for a directory with depth limit.
 *
 * @param dir - Directory path
 * @param maxDepth - Maximum depth to traverse
 * @param currentDepth - Current depth (internal)
 * @param prefix - Line prefix for formatting (internal)
 * @returns Formatted file tree string
 */
async function generateFileTree(dir: string, maxDepth: number, currentDepth = 0, prefix = ""): Promise<string> {
  if (currentDepth >= maxDepth) {
    return "";
  }

  const entries: string[] = [];

  try {
    // readdirSync with withFileTypes avoids a separate stat() call per entry —
    // directory info comes from the single readdir syscall (much faster on large trees).
    const dirEntries = readdirSync(dir, { withFileTypes: true });

    // Sort: directories first, then files
    dirEntries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < dirEntries.length; i++) {
      const dirent = dirEntries[i];
      const isLast = i === dirEntries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      const isDir = dirent.isDirectory();

      entries.push(`${prefix}${connector}${dirent.name}${isDir ? "/" : ""}`);

      // Recurse into directories
      if (isDir) {
        const subtree = await generateFileTree(
          join(dir, dirent.name),
          maxDepth,
          currentDepth + 1,
          prefix + childPrefix,
        );
        if (subtree) {
          entries.push(subtree);
        }
      }
    }
  } catch {
    // Directory not accessible, skip
  }

  return entries.join("\n");
}

/**
 * Detect test patterns from directory structure and dependencies.
 *
 * Checks for:
 * - Test framework (vitest, jest, bun:test, mocha, etc.)
 * - Test directory structure (test/, __tests__/)
 * - Test file patterns (*.test.ts, *.spec.ts)
 *
 * @param workdir - Project root directory
 * @param dependencies - Production dependencies
 * @param devDependencies - Dev dependencies
 * @returns Array of detected patterns
 */
function detectTestPatterns(
  workdir: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): string[] {
  const patterns: string[] = [];
  const allDeps = { ...dependencies, ...devDependencies };

  // Detect test framework
  if (allDeps.vitest) {
    patterns.push("Test framework: vitest");
  } else if (allDeps.jest || allDeps["@jest/globals"]) {
    patterns.push("Test framework: jest");
  } else if (allDeps.mocha) {
    patterns.push("Test framework: mocha");
  } else if (allDeps.ava) {
    patterns.push("Test framework: ava");
  } else {
    // Check for bun:test (no package.json entry)
    patterns.push("Test framework: likely bun:test (no framework dependency)");
  }

  // Detect test directory
  if (existsSync(join(workdir, "test"))) {
    patterns.push("Test directory: test/");
  }
  if (existsSync(join(workdir, "__tests__"))) {
    patterns.push("Test directory: __tests__/");
  }
  if (existsSync(join(workdir, "tests"))) {
    patterns.push("Test directory: tests/");
  }

  // Detect test file patterns
  const hasTestFiles = existsSync(join(workdir, "test")) || existsSync(join(workdir, "src"));
  if (hasTestFiles) {
    patterns.push("Test files: *.test.ts, *.spec.ts");
  }

  return patterns;
}
