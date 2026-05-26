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
import { _smartRunnerDeps } from "../verification/smart-runner";

const DEFAULT_SMART_RUNNER_CONFIG = {
  enabled: true,
  testFilePatterns: [...DEFAULT_TEST_FILE_PATTERNS],
  fallback: "import-grep" as const,
};

export interface SmartRunnerConfigRaw {
  enabled?: boolean;
  testFilePatterns?: string[];
  fallback?: "import-grep" | "full-suite";
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

  const nonTestFiles = await _scopedSelectionDeps.getChangedNonTestFiles(
    input.workdir,
    input.storyGitRef,
    undefined,
    globsToTestRegex(smartCfg.testFilePatterns),
    input.naxIgnoreIndex,
  );

  const pass1Files = await _scopedSelectionDeps.mapSourceToTests(nonTestFiles, input.workdir);
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
    smartCfg.testFilePatterns,
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
  mapSourceToTests: _smartRunnerDeps.mapSourceToTests,
  importGrepFallback: _smartRunnerDeps.importGrepFallback,
  buildSmartTestCommand: _smartRunnerDeps.buildSmartTestCommand,
};
