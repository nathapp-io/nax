import path from "node:path";
import type { PRD, UserStory } from "../prd/types";

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
      return ".nax-acceptance.test.py";
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
  return testPathConfig ?? acceptanceTestFilename(language);
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
  return path.join(packageDir, ".nax", "features", featureName, resolveAcceptanceTestFile(language, testPathConfig));
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
export function groupStoriesByPackage(
  prd: PRD,
  workdir: string,
  featureName: string,
  testPathConfig?: string,
  language?: string,
): AcceptanceTestGroup[] {
  const nonFixStories = prd.userStories.filter((s) => !s.id.startsWith("US-FIX-") && s.status !== "decomposed");

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

  const groups: AcceptanceTestGroup[] = [];
  for (const [wd, { stories, criteria }] of groupMap) {
    const packageDir = wd ? path.join(workdir, wd) : workdir;
    const testPath = resolveAcceptancePackageFeatureTestPath(packageDir, featureName, testPathConfig, language);
    groups.push({ testPath, packageDir, stories, criteria });
  }
  return groups;
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
      return ".nax-suggested.test.py";
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
  return testPathConfig ?? suggestedTestFilename(language);
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
  return path.join(packageDir, ".nax", "features", featureName, resolveSuggestedTestFile(language, testPathConfig));
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
