/**
 * Test Runner Types
 *
 * Shared type definitions for test output parsing across all supported frameworks.
 * These types are re-exported from src/verification/types for backward compatibility.
 */

/** Structured test failure information */
export interface TestFailure {
  /** File path where the test failed */
  file: string;
  /** Full test name (including nested describe blocks) */
  testName: string;
  /** Error message */
  error: string;
  /** Stack trace lines (truncated to first 5 lines) */
  stackTrace: string[];
}

/** Test run summary */
export interface TestSummary {
  /** Number of tests that passed */
  passed: number;
  /** Number of tests that failed */
  failed: number;
  /** Structured failure details */
  failures: TestFailure[];
}

/** Test output analysis result */
export interface TestOutputAnalysis {
  allTestsPassed: boolean;
  passCount: number;
  failCount: number;
  isEnvironmentalFailure: boolean;
  error?: string;
}
