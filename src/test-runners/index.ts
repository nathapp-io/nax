/**
 * Test Runners — Framework Detection and Output Parsing
 *
 * Shared module for all test-framework-aware concerns:
 * - detectFramework(): identify which test runner produced output
 * - parseTestOutput(): structured TestSummary (for regression/rectification)
 * - parseTestFailures(): AC-ID extraction (for acceptance loop)
 * - formatFailureSummary(): agent-readable failure digest
 * - analyzeTestExitCode(): environmental failure detection
 */

export { detectFramework } from "./detector";
export type { Framework } from "./detector";
export { analyzeTestExitCode, formatFailureSummary, parseBunTestOutput, parseTestOutput } from "./parser";
export { parseTestFailures } from "./ac-parser";
export type { TestFailure, TestOutputAnalysis, TestSummary } from "./types";
