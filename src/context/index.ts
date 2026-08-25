/**
 * Context builder module for story-scoped prompt optimization
 */

export { estimateTokens } from "../optimizer/types";
export { type AutoDetectOptions, autoDetectContextFiles, extractKeywords } from "./auto-detect";
export {
  buildContext,
  createDependencyContext,
  createErrorContext,
  createFileContext,
  createProgressContext,
  createStoryContext,
  createTestCoverageContext,
  formatContextAsMarkdown,
  sortContextElements,
} from "./builder";
export {
  _orchestratorDeps,
  ContextOrchestrator,
  DIGEST_RESERVE_TOKENS,
  estimateAvailableBudgetTokens,
  FIXED_RENDER_OVERHEAD_TOKENS,
} from "./engine";
export type { PackedChunk } from "./engine/packing";
export type { AdapterFailure, ContextBundle, ContextChunk } from "./engine/types";
export {
  estimateContextTokens,
  filterContextByRole,
  parseAudienceTags,
  shouldIncludeEntry,
  truncateToContextBudget,
} from "./feature-context-filter";
export { clearFeatureResolverCache, disposeFeatureResolver, resolveFeatureId } from "./feature-resolver";
export {
  _fragmentStoreDeps,
  deleteFragment,
  fragmentPath,
  listFragmentStoryIds,
  readFragment,
  renderFragmentBody,
  truncateToFragmentBudget,
  writeFragment,
} from "./fragments";
export { isGreenfieldStory } from "./greenfield";
export type { FeatureContextResult } from "./providers/feature-context";
export { FeatureContextProvider } from "./providers/feature-context";
export type { CanonicalRule } from "./rules/canonical-loader";
export {
  DEFAULT_CANONICAL_RULES_BUDGET_TOKENS,
  loadCanonicalRules,
  NeutralityLintError,
} from "./rules/canonical-loader";
export type { SectionBudgetResult } from "./rules/rule-budget";
export { applySectionBudget } from "./rules/rule-budget";
export type { RuleSection } from "./rules/rule-sections";
export { splitRuleIntoSections } from "./rules/rule-sections";
export {
  type DescribeBlock,
  extractTestStructure,
  formatTestSummary,
  generateTestCoverageSummary,
  scanTestFiles,
  type TestFileInfo,
  type TestScanOptions,
  type TestScanResult,
  type TestSummaryDetail,
  truncateToTokenBudget,
} from "./test-scanner";
export type { BuiltContext, ContextBudget, ContextElement, StoryContext } from "./types";
