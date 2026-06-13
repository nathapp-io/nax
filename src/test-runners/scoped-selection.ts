/**
 * Scoped Test Selection (issue #1116)
 *
 * Pure helper: given a story's changed files + smart-runner config + base
 * test command, return the effective command + selection metadata.
 *
 * Extracted from src/verification/strategies/scoped.ts (lines 27-120). No
 * behavior change — every code path is preserved verbatim, just behind a
 * stable `selectScopedTests()` boundary so `verifyScopedOp` can call it.
 *
 * Scope: package-scoped (operates on `workdir` + the story's git ref).
 */

import { getLogger } from "@/logger";
import { DEFAULT_TEST_FILE_PATTERNS, globsToTestRegex } from "@/test-runners";
import type { NaxIgnoreIndex } from "@/utils/path-filters";
import { MAX_GREP_TEST_FILES, _smartRunnerDeps } from "../verification/smart-runner";
import type { ResolvedTestPatterns } from "./resolver";

const DEFAULT_SMART_RUNNER_CONFIG = {
  enabled: true,
  testFilePatterns: [...DEFAULT_TEST_FILE_PATTERNS],
  fallback: "import-grep" as const,
  maxScanFiles: MAX_GREP_TEST_FILES,
};

export interface SmartRunnerConfigRaw {
  enabled?: boolean;
  testFilePatterns?: string[];
  fallback?: "import-grep" | "full-suite";
  maxScanFiles?: number;
}

export function coerceSmartRunner(val: unknown) {
  if (val === undefined || val === true) return DEFAULT_SMART_RUNNER_CONFIG;
  if (val === false) return { ...DEFAULT_SMART_RUNNER_CONFIG, enabled: false };
  return { ...DEFAULT_SMART_RUNNER_CONFIG, ...(val as Partial<typeof DEFAULT_SMART_RUNNER_CONFIG>) };
}

export function buildScopedCommand(
  testFiles: string[],
  baseCommand: string,
  testScopedTemplate: string | undefined,
): string {
  if (testScopedTemplate) {
    const quotedFiles = testFiles.map((file) => `'${file.replaceAll("'", "'\\''")}'`);
    return testScopedTemplate.replace("{{files}}", quotedFiles.join(" "));
  }
  return _scopedSelectionDeps.buildSmartTestCommand(testFiles, baseCommand);
}

/**
 * Monorepo orchestrators (turbo, nx) carry their own change-filter syntax
 * (e.g. `--filter=...[HEAD~1]`, `nx affected`). Smart-runner must not append
 * file paths to such commands — it would produce invalid syntax.
 */
export function isMonorepoOrchestratorCommand(command: string): boolean {
  return /\bturbo\b/.test(command) || /\bnx\b/.test(command);
}

export interface SelectScopedTestsInput {
  workdir: string;
  storyId: string;
  storyGitRef?: string;
  testCommand: string;
  testScopedTemplate?: string;
  smartRunnerConfig: unknown;
  scopeTestThreshold?: number;
  fallbackFullSuiteCommand?: string;
  naxIgnoreIndex?: NaxIgnoreIndex;
  /**
   * Absolute repo root — anchor for changed-test detection and path-convention
   * mapping in monorepos. Defaults to `workdir` for single-package layouts.
   */
  repoRoot?: string;
  /** Story workdir relative to repoRoot (e.g. "packages/core") — scopes the git diff. */
  packagePrefix?: string;
  /**
   * ADR-009 resolved test patterns. When present, `.regex` drives changed-file
   * classification and `.globs` drives suffix derivation — language-agnostic and
   * per-package override-aware. Falls back to `smartRunnerConfig.testFilePatterns`.
   */
  resolvedTestPatterns?: ResolvedTestPatterns;
}

export interface SelectScopedTestsResult {
  effectiveCommand: string;
  isFullSuite: boolean;
  scopeTestFallback?: boolean;
  thresholdFallback: boolean;
  isMonorepoOrchestrator: boolean;
}

export async function selectScopedTests(input: SelectScopedTestsInput): Promise<SelectScopedTestsResult> {
  const logger = getLogger();
  const smartCfg = coerceSmartRunner(input.smartRunnerConfig);
  const isMonorepoOrchestrator = isMonorepoOrchestratorCommand(input.testCommand);
  const threshold = input.scopeTestThreshold ?? 10;

  const fullSuite = (opts?: { scopeTestFallback?: boolean; thresholdFallback?: boolean }): SelectScopedTestsResult => ({
    effectiveCommand: input.fallbackFullSuiteCommand ?? input.testCommand,
    isFullSuite: true,
    scopeTestFallback: opts?.scopeTestFallback,
    thresholdFallback: opts?.thresholdFallback ?? false,
    isMonorepoOrchestrator,
  });

  const scoped = (files: string[]): SelectScopedTestsResult => ({
    effectiveCommand: buildScopedCommand(files, input.testCommand, input.testScopedTemplate),
    isFullSuite: false,
    thresholdFallback: false,
    isMonorepoOrchestrator,
  });

  if (!smartCfg.enabled || !input.storyGitRef || isMonorepoOrchestrator) {
    return { effectiveCommand: input.testCommand, isFullSuite: true, thresholdFallback: false, isMonorepoOrchestrator };
  }

  // Anchors: prefer the ADR-009 resolved patterns + repo-root/package-prefix when the
  // caller supplies them (language-agnostic, monorepo-correct). Fall back to the raw
  // smart-runner patterns + workdir for single-package callers and unit tests.
  const repoRoot = input.repoRoot ?? input.workdir;
  const classifyRegex = input.resolvedTestPatterns?.regex
    ? [...input.resolvedTestPatterns.regex]
    : globsToTestRegex(smartCfg.testFilePatterns);
  const mappingGlobs = input.resolvedTestPatterns?.globs
    ? [...input.resolvedTestPatterns.globs]
    : smartCfg.testFilePatterns;

  // Pass 0 — changed test files detected directly from the git diff (restored from
  // pre-#1084 verify.ts). A test file that changed in the story commit is already a
  // test: run it directly, no source→test mapping needed. This is the language-agnostic
  // path that catches Python `test_*.py`, Go `_test.go`, etc. (issue: smart-runner
  // scoped selection was TS-centric after the builder-phase unification).
  //
  // NOTE: the threshold gate below is NOT in the historical verify.ts (which ran every
  // changed test unconditionally). It was added here for parity with Pass 1/2 — capping
  // the scoped command size. Side effect: a story changing > threshold test files falls
  // back to the full suite (skipped in deferred mode, deferred to run-end).
  const changedTestFiles = await _scopedSelectionDeps.getChangedTestFiles(
    input.workdir,
    repoRoot,
    input.storyGitRef,
    input.packagePrefix,
    classifyRegex,
    input.naxIgnoreIndex,
  );
  if (changedTestFiles.length > threshold) {
    logger.warn(
      "verify[scoped]",
      `Changed test file count ${changedTestFiles.length} exceeds threshold ${threshold} — falling back to full suite`,
      { storyId: input.storyId },
    );
    return fullSuite({ scopeTestFallback: true, thresholdFallback: true });
  }
  if (changedTestFiles.length > 0) {
    logger.info("verify[scoped]", `Pass 0: ${changedTestFiles.length} changed test file(s) detected directly`, {
      storyId: input.storyId,
    });
    return scoped(changedTestFiles);
  }

  const nonTestFiles = await _scopedSelectionDeps.getChangedNonTestFiles(
    input.workdir,
    input.storyGitRef,
    input.packagePrefix,
    classifyRegex,
    input.naxIgnoreIndex,
    repoRoot,
  );

  const pass1Files = await _scopedSelectionDeps.mapSourceToTests(
    nonTestFiles,
    repoRoot,
    input.packagePrefix,
    mappingGlobs,
  );
  if (pass1Files.length > threshold) {
    logger.warn(
      "verify[scoped]",
      `Scoped test file count ${pass1Files.length} exceeds threshold ${threshold} — falling back to full suite`,
      { storyId: input.storyId },
    );
    return fullSuite({ scopeTestFallback: true, thresholdFallback: true });
  }
  if (pass1Files.length > 0) {
    logger.info("verify[scoped]", `Pass 1: path convention matched ${pass1Files.length} test files`, {
      storyId: input.storyId,
    });
    return scoped(pass1Files);
  }

  if (smartCfg.fallback !== "import-grep") {
    return fullSuite();
  }

  const pass2Files = await _scopedSelectionDeps.importGrepFallback(
    nonTestFiles,
    input.workdir,
    mappingGlobs,
    smartCfg.maxScanFiles,
  );
  if (pass2Files.length > threshold) {
    logger.warn(
      "verify[scoped]",
      `Scoped test file count ${pass2Files.length} exceeds threshold ${threshold} — falling back to full suite`,
      { storyId: input.storyId },
    );
    return fullSuite({ scopeTestFallback: true, thresholdFallback: true });
  }
  if (pass2Files.length > 0) {
    logger.info("verify[scoped]", `Pass 2: import-grep matched ${pass2Files.length} test files`, {
      storyId: input.storyId,
    });
    return scoped(pass2Files);
  }

  return fullSuite();
}

/** Injectable deps for testing. Mirrors `_scopedDeps` from strategies/scoped.ts. */
export const _scopedSelectionDeps = {
  getChangedNonTestFiles: _smartRunnerDeps.getChangedNonTestFiles,
  getChangedTestFiles: _smartRunnerDeps.getChangedTestFiles,
  mapSourceToTests: _smartRunnerDeps.mapSourceToTests,
  importGrepFallback: _smartRunnerDeps.importGrepFallback,
  buildSmartTestCommand: _smartRunnerDeps.buildSmartTestCommand,
};
