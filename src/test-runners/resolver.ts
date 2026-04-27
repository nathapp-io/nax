/**
 * Test File Pattern Resolver — SSOT
 *
 * `resolveTestFilePatterns()` is the single source of truth for "which files
 * are test files?". Every classification site in the codebase goes through
 * this resolver; inline test-file checks are forbidden (ADR-009).
 *
 * Resolution chain (first non-undefined wins):
 *   1. Per-package config  — .nax/mono/<packageDir>/config.json (monorepo)
 *   2. Root config         — config.execution.smartTestRunner.testFilePatterns
 *   3. Detection           — detectTestFilePatterns(workdir) [Phase 1: stub]
 *   4. Fallback            — DEFAULT_TEST_FILE_PATTERNS
 *
 * Explicit `testFilePatterns: []` in config is honoured as "no test files"
 * — semantically distinct from the key being omitted.
 *
 * Injectable `_resolverDeps` follows the project `_deps` pattern.
 */

import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { NaxConfig } from "../config/types";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { DEFAULT_TEST_FILE_PATTERNS, extractTestDirs, globsToPathspec, globsToTestRegex } from "./conventions";
import type { DetectionResult } from "./detect";
import { detectTestFilePatterns } from "./detect";

// ─── Public types ──────────────────────────────────────────────────────────────

/**
 * All four pattern formats derived from a single source, guaranteed consistent.
 *
 * Consumers pick the format they need; they never translate between formats
 * themselves — that translation lives here, tested once, consistent everywhere.
 */
export interface ResolvedTestPatterns {
  /** Glob form — for file matchers: ["**\/*.test.ts"] */
  readonly globs: readonly string[];
  /** Git pathspec form for diff exclusion: [":!*.test.ts"] */
  readonly pathspec: readonly string[];
  /** Regex form for path classification: [/\.test\.ts$/] */
  readonly regex: readonly RegExp[];
  /** Directory names extracted from leading glob segments: ["test", "__tests__"] */
  readonly testDirs: readonly string[];
  /**
   * Which tier resolved the patterns.
   * Distinct from DetectionSource.type (which is a detection-tier label).
   */
  readonly resolution: "per-package" | "root-config" | "detected" | "fallback";
}

// ─── Parity constants (§4.4) ──────────────────────────────────────────────────

/**
 * Well-known test directory names always excluded from review diffs.
 *
 * Included in the derived `excludePatterns` regardless of user config to
 * prevent regressing against the current hardcoded default and to handle
 * polyglot repos where some directories may not be covered by user patterns.
 */
const WELL_KNOWN_TEST_DIRS = ["test", "tests", "__tests__"] as const;

/**
 * Well-known test file suffixes always excluded from review diffs.
 * Prevents vendored test files from leaking into semantic review even when
 * the user configures non-default `testFilePatterns`.
 */
const WELL_KNOWN_TEST_SUFFIXES = ["*.test.ts", "*.spec.ts", "*_test.go"] as const;

/** nax metadata paths — always noise, always excluded. */
const NAX_NOISE_PATHS = [".nax/", ".nax-pids"] as const;

// ─── Injectable deps ──────────────────────────────────────────────────────────

/** Injectable dependencies — mock these in tests; never use mock.module(). */
export const _resolverDeps = {
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readJson: async (path: string): Promise<unknown> => JSON.parse(await Bun.file(path).text()),
  detectTestFilePatterns: detectTestFilePatterns as (workdir: string) => Promise<DetectionResult>,
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildResolved(globs: readonly string[], resolution: ResolvedTestPatterns["resolution"]): ResolvedTestPatterns {
  return {
    globs,
    pathspec: globsToPathspec(globs),
    regex: globsToTestRegex(globs),
    testDirs: extractTestDirs(globs),
    resolution,
  };
}

function validateGlobs(patterns: readonly string[], stage: string): void {
  for (const p of patterns) {
    if (typeof p !== "string" || p.trim().length === 0) {
      throw new NaxError(`Invalid test glob pattern: "${p}"`, "INVALID_TEST_GLOB", { pattern: p, stage });
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Options for resolveTestFilePatterns */
export interface ResolveTestFilePatternsOptions {
  /** Story ID for structured log correlation */
  storyId?: string;
}

/**
 * Resolve effective test file patterns for the given config and optional
 * monorepo package directory.
 *
 * @param config     - Root NaxConfig (project-level merged config).
 * @param workdir    - Absolute path to project root (for mono config lookup + detection).
 * @param packageDir - Relative path to the monorepo package (e.g. "packages/api").
 *                     Pass `undefined` for single-package projects.
 * @param options    - Optional: storyId for log correlation.
 */
export async function resolveTestFilePatterns(
  config: NaxConfig,
  workdir: string,
  packageDir?: string,
  options?: ResolveTestFilePatternsOptions,
): Promise<ResolvedTestPatterns> {
  if (packageDir !== undefined && isAbsolute(packageDir)) {
    throw new NaxError(
      `resolveTestFilePatterns: packageDir must be relative to workdir, got absolute path "${packageDir}"`,
      "INVALID_PACKAGE_DIR",
      { stage: "resolver", workdir, packageDir },
    );
  }

  // 1. Per-package override
  if (packageDir) {
    const monoConfigPath = `${workdir}/.nax/mono/${packageDir}/config.json`;
    try {
      const exists = await _resolverDeps.fileExists(monoConfigPath);
      if (exists) {
        const monoRaw = await _resolverDeps.readJson(monoConfigPath);
        // Type-safe access into the raw JSON shape of a per-package config
        type MonoConfigShape = { execution?: { smartTestRunner?: { testFilePatterns?: string[] } } };
        const perPkgPatterns = (monoRaw as MonoConfigShape)?.execution?.smartTestRunner?.testFilePatterns;
        if (perPkgPatterns !== undefined) {
          validateGlobs(perPkgPatterns, "resolver");
          return buildResolved(perPkgPatterns, "per-package");
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Missing mono config — fall through to root config
      } else if (err instanceof NaxError) {
        throw err;
      } else {
        throw new NaxError("Failed to read per-package config", "MONO_CONFIG_READ_FAILED", {
          packageDir,
          stage: "resolver",
          cause: err,
        });
      }
    }
  }

  // 2. Root config explicit patterns
  // smartTestRunner can be boolean (legacy compat) or SmartTestRunnerConfig object.
  const smartRunner = config.execution?.smartTestRunner;
  const rootPatterns =
    typeof smartRunner === "object" && smartRunner !== null ? smartRunner.testFilePatterns : undefined;
  if (rootPatterns !== undefined) {
    validateGlobs(rootPatterns, "resolver");
    return buildResolved(rootPatterns, "root-config");
  }

  // 3. Detection — scan from the package directory when available so auto-detected
  // patterns are package-relative (e.g. "src/**/*.test.ts") rather than rooted
  // at the repo (e.g. "packages/lib/src/**/*.test.ts"), which would produce
  // doubled paths when joined with packageDir in code-neighbor.
  const detectionWorkdir = packageDir ? join(workdir, packageDir) : workdir;
  const detected = await _resolverDeps.detectTestFilePatterns(detectionWorkdir);
  if (detected.confidence !== "empty" && detected.patterns.length > 0) {
    getSafeLogger()?.info("resolver", "Test patterns auto-detected", {
      ...(options?.storyId !== undefined && { storyId: options.storyId }),
      confidence: detected.confidence,
      patternCount: detected.patterns.length,
      tier: detected.sources[0]?.type,
    });
    validateGlobs([...detected.patterns], "resolver");
    return buildResolved(detected.patterns, "detected");
  }

  // 4. Fallback to canonical default
  return buildResolved(DEFAULT_TEST_FILE_PATTERNS, "fallback");
}

/**
 * Resolve the effective `excludePatterns` list for review diff exclusion.
 *
 * When the user has set `excludePatterns` explicitly (any value, including
 * empty array) → returned verbatim. User override always wins.
 *
 * When `userExplicit` is `undefined` → derives from resolved test patterns +
 * well-known noise dirs. Derivation preserves parity with the current
 * hardcoded default for TS projects (see §4.4 of the spec for proof).
 */
export function resolveReviewExcludePatterns(
  userExplicit: readonly string[] | undefined,
  resolved: ResolvedTestPatterns,
): readonly string[] {
  if (userExplicit !== undefined) return userExplicit;

  const result = new Set<string>();

  // 1. Project's resolved test patterns (from user config / detection)
  for (const p of resolved.pathspec) result.add(p);
  for (const d of resolved.testDirs) result.add(`:!${d}/`);

  // 2. Well-known test dirs/suffixes — always excluded to prevent regression
  //    vs. current hardcoded default and to handle polyglot repos.
  for (const d of WELL_KNOWN_TEST_DIRS) result.add(`:!${d}/`);
  for (const s of WELL_KNOWN_TEST_SUFFIXES) result.add(`:!${s}`);

  // 3. nax noise paths
  for (const p of NAX_NOISE_PATHS) result.add(`:!${p}`);

  return [...result];
}

/**
 * Walk up from `filePath` to find the nearest monorepo package directory
 * relative to `workdir`.
 *
 * Returns `undefined` when at the workdir root (single-package project or
 * file not in a sub-package). Used by classification sites that only have
 * a file path and need to discover the package context.
 *
 * Callers operating on many files should call this once per story/package,
 * not per file — see §2.8 of the spec for the resolve-once-classify-many
 * pattern.
 */
export async function findPackageDir(filePath: string, workdir: string): Promise<string | undefined> {
  let dir = resolve(workdir, dirname(filePath));
  const resolvedWorkdir = resolve(workdir);

  while (dir !== resolvedWorkdir && dir !== dirname(dir)) {
    const rel = relative(resolvedWorkdir, dir);
    const monoConfigPath = `${resolvedWorkdir}/.nax/mono/${rel}/config.json`;
    const exists = await _resolverDeps.fileExists(monoConfigPath);
    if (exists) return rel;

    // Also check for standard package boundary markers
    for (const marker of ["package.json", "go.mod", "pyproject.toml", "Cargo.toml"]) {
      const markerExists = await _resolverDeps.fileExists(`${dir}/${marker}`);
      if (markerExists) {
        const rel2 = relative(resolvedWorkdir, dir);
        if (rel2 && rel2 !== ".") return rel2;
      }
    }

    dir = dirname(dir);
  }

  return undefined;
}
