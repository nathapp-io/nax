/**
 * Test Output Parser
 *
 * DEPRECATED: Use src/verification/parser.ts instead.
 * This file is kept for backward compatibility only.
 */

// Re-export from unified verification layer
export {
  type TestFailure,
  type TestSummary,
  parseBunTestOutput,
  formatFailureSummary,
} from "../verification/parser";
