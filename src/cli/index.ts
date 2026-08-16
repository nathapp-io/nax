/**
 * CLI Utilities
 */

export { planCommand, buildPlanComposition, resolvePlanMode, runPlanPipeline, _planDeps } from "./plan";
export { detectProjectName, DEFAULT_TIMEOUT_SECONDS, createPlanRuntime } from "./plan-runtime";
export type { PlanCommandOptions } from "./plan";
export { planDecomposeCommand, runReplanLoop } from "./plan-decompose";
export { buildSourceRootsSection, buildPackageSummary } from "./plan-helpers";
export { acceptCommand, type AcceptOptions } from "./accept";
export {
  displayCostMetrics,
  displayLastRunMetrics,
  displayModelEfficiency,
  emitCostReportJson,
  type CostReportEmitDeps,
  displayFeatureStatus,
  type FeatureStatusOptions,
} from "./status";
export {
  dispatchStatusView,
  registerStatusCommand,
  runStatusAction,
  _statusViewDeps,
  _statusCommandActionDeps,
  type StatusCommandActionDeps,
  type StatusViewDeps,
  type StatusViewOptions,
} from "./status-dispatch";
export {
  runsListCommand,
  runsShowCommand,
  type RunsListOptions,
  type RunsShowOptions,
} from "./runs";
export {
  promptsCommand,
  promptsInitCommand,
  exportPromptCommand,
  _promptsMainDeps,
  type PromptsCommandOptions,
  type PromptsInitCommandOptions,
  type ExportPromptCommandOptions,
} from "./prompts";
export { initCommand, type InitOptions } from "./init";
export { setupCommand, type SetupOptions } from "./setup";
export { writeSetupConfig, _writeSetupDeps, type WriteSetupConfigResult } from "./setup-write";
export { pluginsListCommand } from "./plugins";
export { generateCommand, type GenerateCommandOptions } from "./generate";
export { configCommand, type ConfigCommandOptions } from "./config";
export { promptForConfirmation, _confirmDeps, type ConfirmStdin } from "./confirm";
export { agentsListCommand } from "./agents";
export { contextInspectCommand, type ContextInspectOptions } from "./context";
export {
  effectivenessEvalCommand,
  formatEffectivenessReport,
  formatEffectivenessError,
  _effectivenessEvalDeps,
  type EffectivenessEvalOptions,
} from "./context";
export {
  _contextFragmentsDeps,
  formatFragmentsInspect,
  formatFragmentsPrune,
  fragmentsInspectCommand,
  fragmentsPruneCommand,
  listDependentStoryIds,
  type FragmentInspectEntry,
  type FragmentsInspectFormatOptions,
  type FragmentsInspectOptions,
  type FragmentsPruneOptions,
  type FragmentsPruneSummary,
  type LoadPRDResult,
} from "./context-fragments";
export {
  _rulesCLIDeps,
  rulesExportCommand,
  rulesLintCommand,
  rulesMigrateCommand,
  neutralizeContent,
  translateLegacyFrontmatter,
  withReviewNotice,
  type RulesExportOptions,
  type RulesLintOptions,
  type RulesMigrateOptions,
  type MigrationOutcome,
} from "./rules";
export {
  planMigration,
  type MigrationPlanEntry,
  type MigrationPlan,
  type PlanMigrationOptions,
} from "./rules-migrate-plan";
export {
  _rulesLintDeps,
  collectCanonicalRuleRoots,
  rulesLintCommand as rulesLintCommandDirect,
  MAX_DEAD_GLOB_SCAN_FILES,
  MAX_DEAD_GLOB_SCAN_TOTAL_ENTRIES,
  MAX_CANONICAL_RULE_GLOB_FILES,
  CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS,
  DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS,
  type RulesLintOptions as RulesLintOptionsFromLint,
} from "./rules-lint";
export { resolveRunProfileOverride } from "./resolve-run-profile";
export { resolveFeatureSpec } from "./features-resolve";
export type { ResolveResult, ResolveStatus, SpecSource, SpecSourceKind } from "./features-resolve";
export { resolveFeatureAcceptance } from "./features-acceptance";
export type {
  AcceptanceGroupResult,
  AcceptanceResolution,
  AcceptanceResolutionStatus,
} from "./features-acceptance";
export {
  _routingCalibrateDeps,
  parseMinSamplesFlag,
  routingCalibrateCommand,
  runRoutingCalibrateCli,
  type RoutingCalibrateDeps,
  type RoutingCalibrateOptions,
  type RoutingCalibrateResult,
} from "./routing-calibrate";

export { FIELD_DESCRIPTIONS } from "./config-descriptions";
