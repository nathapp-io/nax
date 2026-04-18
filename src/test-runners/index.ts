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
export { createTestFileClassifier } from "./classifier";
export type { DetectionResult, DetectionSource } from "./detect";
export { detectTestFilePatterns } from "./detect";
export { buildTestFrameworkHint, detectFramework, isTestFile } from "./detector";
export type { Framework } from "./detector";
export {
  _resolverDeps,
  findPackageDir,
  resolveReviewExcludePatterns,
  resolveTestFilePatterns,
} from "./resolver";
export type { ResolvedTestPatterns } from "./resolver";
export { analyzeTestExitCode, formatFailureSummary, parseBunTestOutput, parseTestOutput } from "./parser";
export { parseTestFailures } from "./ac-parser";
export type { TestFailure, TestOutputAnalysis, TestSummary } from "./types";
