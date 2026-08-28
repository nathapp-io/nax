/**
 * Test Runners — Framework Detection, Output Parsing, and Pattern SSOT
 *
 * Shared module for all test-framework-aware concerns:
 * - detectFramework(): identify which test runner produced output
 * - parseTestOutput(): structured TestSummary (for regression/rectification)
 * - parseTestFailures(): AC-ID extraction (for acceptance loop)
 * - formatFailureSummary(): agent-readable failure digest
 * - analyzeTestExitCode(): environmental failure detection
 * - resolveTestFilePatterns() + createTestFileClassifier(): ADR-009 SSOT
 */

export { parseTestFailures, parseTestFailuresDetailed } from "./ac-parser";
export { createTestFileClassifier } from "./classifier";
export {
  DEFAULT_SCAN_TEST_DIRS,
  DEFAULT_SEPARATED_TEST_DIRS,
  DEFAULT_TEST_FILE_PATTERNS,
  DEFAULT_TS_DERIVE_SUFFIXES,
  extractTestDirs,
  globsToPathspec,
  globsToTestRegex,
  isTestFileByPatterns,
} from "./conventions";
export type { DetectionResult, DetectionSource } from "./detect";
export {
  clearWorkspaceCache,
  detectManifestFrameworksFromPackageJson,
  detectTestFilePatterns,
  discoverWorkspacePackages,
} from "./detect";
export type { Framework } from "./detector";
export { buildTestFrameworkHint, detectFramework, isTestFile } from "./detector";
export { parseMochaOutput } from "./parse-mocha";
export { parseRustTestOutput } from "./parse-rust";
export { analyzeTestExitCode, formatFailureSummary, parseBunTestOutput, parseTestOutput } from "./parser";
export type { ResolvedTestPatterns } from "./resolver";
export {
  _resolverDeps,
  buildResolved,
  findPackageDir,
  resolveReviewExcludePatterns,
  resolveTestFilePatterns,
} from "./resolver";
export type { SelectScopedTestsInput, SelectScopedTestsResult } from "./scoped-selection";
export {
  _scopedSelectionDeps,
  buildScopedCommand,
  coerceSmartRunner,
  isMonorepoOrchestratorCommand,
  selectScopedTests,
} from "./scoped-selection";
export type { TestFailure, TestOutputAnalysis, TestSummary } from "./types";
