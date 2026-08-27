import path from "node:path";
import { featureDir } from "@/config";
import { isInAcceptanceScope } from "@/prd";
import type { PRD, UserStory } from "../prd/types";
import { detectLanguage as _detectLanguage } from "../project/detector";

async function _readPackageTestPath(workdir: string, relativeDir: string): Promise<string | undefined> {
  if (!relativeDir) return undefined;
  if (path.isAbsolute(relativeDir) || relativeDir.split(path.sep).includes("..")) return undefined;
  const cfgPath = path.join(workdir, ".nax", "mono", relativeDir, "config.json");
  const file = Bun.file(cfgPath);
  if (!(await file.exists())) return undefined;
  try {
    const cfg = JSON.parse(await file.text()) as { acceptance?: { testPath?: string } };
    return cfg?.acceptance?.testPath;
  } catch {
    return undefined;
  }
}

export const _groupDeps = {
  detectLanguage: _detectLanguage as (dir: string) => Promise<string | undefined>,
  readPackageTestPath: _readPackageTestPath,
};

export interface AcceptanceTestPathEntry {
  testPath: string;
  packageDir: string;
}

export interface ResolveAcceptanceTestCandidatesOptions {
  acceptanceTestPaths?: AcceptanceTestPathEntry[];
  featureDir?: string;
  testPathConfig?: string;
  language?: string;
}

/**
 * Return the acceptance test filename for a given language.
 * Files are dot-prefixed and placed at the package root (not inside .nax/).
 */
export function acceptanceTestFilename(language?: string): string {
  switch (language?.toLowerCase()) {
    case "go":
      return ".nax-acceptance_test.go";
    case "python":
      return "_nax_acceptance_test.py";
    case "rust":
      return ".nax-acceptance.rs";
    default:
      return ".nax-acceptance.test.ts";
  }
}

/**
 * Resolve acceptance test filename based on explicit config override and language.
 */
export function resolveAcceptanceTestFile(language?: string, testPathConfig?: string): string {
  const candidate = testPathConfig ?? acceptanceTestFilename(language);
  return sanitizeTestFileName(candidate, "acceptance.testPath");
}

/**
 * Resolve single-feature acceptance test absolute path.
 */
export function resolveAcceptanceFeatureTestPath(
  featureDir: string,
  testPathConfig?: string,
  language?: string,
): string {
  return path.join(featureDir, resolveAcceptanceTestFile(language, testPathConfig));
}

/**
 * Resolve package-scoped acceptance test absolute path (monorepo aware).
 */
export function resolveAcceptancePackageFeatureTestPath(
  packageDir: string,
  featureName: string,
  testPathConfig?: string,
  language?: string,
): string {
  return path.join(featureDir(packageDir, featureName), resolveAcceptanceTestFile(language, testPathConfig));
}

/**
 * Resolve ordered candidate acceptance test paths.
 * Priority:
 * 1) precomputed per-package acceptanceTestPaths
 * 2) featureDir + configured/language filename fallback
 */
export function resolveAcceptanceTestCandidates(options: ResolveAcceptanceTestCandidatesOptions): string[] {
  if (options.acceptanceTestPaths && options.acceptanceTestPaths.length > 0) {
    return options.acceptanceTestPaths.map((p) => p.testPath);
  }
  if (!options.featureDir) return [];
  return [resolveAcceptanceFeatureTestPath(options.featureDir, options.testPathConfig, options.language)];
}

// ─── Per-package grouping (monorepo) ────────────────────────────────────────

/**
 * One acceptance test group per unique story.workdir value in the PRD.
 * Returned by groupStoriesByPackage — used by both acceptance-setup (generation)
 * and runner-completion (path resolution for the acceptance loop).
 */
export interface AcceptanceTestGroup {
  testPath: string;
  packageDir: string;
  stories: UserStory[];
  criteria: string[];
  /** Per-package detected language (used for skeleton fallback). */
  language: string | undefined;
}

/**
 * Group non-fix, non-decomposed PRD stories by story.workdir and compute the
 * acceptance test path for each group.
 *
 * This is the SSOT for per-package test path computation. Call it from:
 *   - acceptance-setup stage (to generate test files + set ctx.acceptanceTestPaths)
 *   - runner-completion (to pass acceptanceTestPaths into runAcceptanceLoop)
 *
 * @param prd         - The loaded PRD
 * @param workdir     - Absolute repo root (ctx.workdir / options.workdir)
 * @param featureName - Feature name used in the test file path
 * @param testPathConfig - Optional override filename from config.acceptance.testPath
 * @param language    - Optional language from config.project.language
 */
export async function groupStoriesByPackage(
  prd: PRD,
  workdir: string,
  featureName: string,
  testPathConfig?: string,
  language?: string,
): Promise<AcceptanceTestGroup[]> {
  const nonFixStories = prd.userStories.filter(isInAcceptanceScope);

  const groupMap = new Map<string, { stories: UserStory[]; criteria: string[] }>();
  for (const story of nonFixStories) {
    const wd = story.workdir ?? "";
    if (!groupMap.has(wd)) {
      groupMap.set(wd, { stories: [], criteria: [] });
    }
    const group = groupMap.get(wd);
    if (group) {
      group.stories.push(story);
      group.criteria.push(...story.acceptanceCriteria);
    }
  }

  // Fallback: always have at least the root group so RED gate runs
  if (groupMap.size === 0) {
    groupMap.set("", { stories: [], criteria: [] });
  }

  // Detect language per package in parallel so polyglot monorepos (e.g. Python API + TS web)
  // get the correct test file extension. Falls back to the global language when detection
  // returns undefined (e.g. no package markers, temp dirs in tests).
  return Promise.all(
    Array.from(groupMap.entries()).map(async ([wd, { stories, criteria }]) => {
      const packageDir = wd ? path.join(workdir, wd) : workdir;
      // Per-package config acceptance.testPath takes precedence over root config and language detection.
      const pkgTestPath = await _groupDeps.readPackageTestPath(workdir, wd);
      const detectedLang = await _groupDeps.detectLanguage(packageDir);
      const resolvedLang = detectedLang ?? language;
      const resolvedTestPathConfig = pkgTestPath ?? testPathConfig;
      const testPath = resolveAcceptancePackageFeatureTestPath(
        packageDir,
        featureName,
        resolvedTestPathConfig,
        resolvedLang,
      );
      return { testPath, packageDir, stories, criteria, language: resolvedLang };
    }),
  );
}

// ─── Suggested test path helpers (hardening pass) ───────────────────────────

/**
 * Return the suggested test filename for a given language.
 * Mirrors acceptanceTestFilename() but with `.nax-suggested` prefix.
 */
export function suggestedTestFilename(language?: string): string {
  switch (language?.toLowerCase()) {
    case "go":
      return ".nax-suggested_test.go";
    case "python":
      return "_nax_suggested_test.py";
    case "rust":
      return ".nax-suggested.rs";
    default:
      return ".nax-suggested.test.ts";
  }
}

/**
 * Resolve suggested test filename based on explicit config override and language.
 */
export function resolveSuggestedTestFile(language?: string, testPathConfig?: string): string {
  const candidate = testPathConfig ?? suggestedTestFilename(language);
  return sanitizeTestFileName(candidate, "acceptance.suggestedTestPath");
}

function sanitizeTestFileName(value: string, fieldName: string): string {
  const filename = value.trim();
  if (filename.length === 0) {
    throw new Error(`${fieldName} must be non-empty`);
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw new Error(`${fieldName} must be a filename, not a path: ${filename}`);
  }
  if (filename.includes("..")) {
    throw new Error(`${fieldName} cannot contain '..': ${filename}`);
  }
  return filename;
}

/**
 * Resolve package-scoped suggested test absolute path (monorepo aware).
 */
export function resolveSuggestedPackageFeatureTestPath(
  packageDir: string,
  featureName: string,
  testPathConfig?: string,
  language?: string,
): string {
  return path.join(featureDir(packageDir, featureName), resolveSuggestedTestFile(language, testPathConfig));
}

/**
 * Find the first existing acceptance test path from resolved candidates.
 */
export async function findExistingAcceptanceTestPath(
  options: ResolveAcceptanceTestCandidatesOptions,
): Promise<string | undefined> {
  const candidates = resolveAcceptanceTestCandidates(options);
  for (const testPath of candidates) {
    if (await Bun.file(testPath).exists()) {
      return testPath;
    }
  }
  return undefined;
}
