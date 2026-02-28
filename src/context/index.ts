/**
 * Context builder module for story-scoped prompt optimization
 */

export type { ContextElement, ContextBudget, StoryContext, BuiltContext } from "./types";

export {
  estimateTokens,
  createStoryContext,
  createDependencyContext,
  createErrorContext,
  createProgressContext,
  createFileContext,
  sortContextElements,
  buildContext,
  createTestCoverageContext,
  formatContextAsMarkdown,
} from "./builder";

export {
  generateTestCoverageSummary,
  scanTestFiles,
  extractTestStructure,
  formatTestSummary,
  truncateToTokenBudget,
  type TestScanOptions,
  type TestScanResult,
  type TestFileInfo,
  type DescribeBlock,
  type TestSummaryDetail,
} from "./test-scanner";

export { autoDetectContextFiles, extractKeywords, type AutoDetectOptions } from "./auto-detect";
