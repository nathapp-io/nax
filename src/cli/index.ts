/**
 * CLI Utilities
 */

export { type AcceptOptions, acceptCommand } from "./accept";
export { agentsListCommand } from "./agents";
export {
  _cliAuthDeps,
  authImportCommand,
  authListCommand,
  authLoginCommand,
  authRmCommand,
} from "./auth";
export { _authPromptDeps, PromptCancelledError, type PromptStdin, promptForLine, promptForSecret } from "./auth-prompt";
export { type ConfigCommandOptions, configCommand } from "./config";
export { FIELD_DESCRIPTIONS } from "./config-descriptions";
export { _confirmDeps, type ConfirmStdin, promptForConfirmation } from "./confirm";
export {
  _effectivenessEvalDeps,
  type ContextInspectOptions,
  contextInspectCommand,
  type EffectivenessEvalOptions,
  effectivenessEvalCommand,
  formatEffectivenessError,
  formatEffectivenessReport,
} from "./context";
export {
  _contextFragmentsDeps,
  type FragmentInspectEntry,
  type FragmentsInspectFormatOptions,
  type FragmentsInspectOptions,
  type FragmentsPruneOptions,
  type FragmentsPruneSummary,
  formatFragmentsInspect,
  formatFragmentsPrune,
  fragmentsInspectCommand,
  fragmentsPruneCommand,
  type LoadPRDResult,
  listDependentStoryIds,
} from "./context-fragments";
export type {
  AcceptanceGroupResult,
  AcceptanceResolution,
  AcceptanceResolutionStatus,
} from "./features-acceptance";
export { resolveFeatureAcceptance } from "./features-acceptance";
export type { ResolveResult, ResolveStatus, SpecSource, SpecSourceKind } from "./features-resolve";
export { resolveFeatureSpec } from "./features-resolve";
export { type GenerateCommandOptions, generateCommand } from "./generate";
export { type InitOptions, initCommand } from "./init";
export type { PlanCommandOptions } from "./plan";
export { _planDeps, buildPlanComposition, planCommand, resolvePlanMode, runPlanPipeline } from "./plan";
export { planDecomposeCommand, runReplanLoop } from "./plan-decompose";
export { buildPackageSummary, buildSourceRootsSection } from "./plan-helpers";
export { createPlanRuntime, DEFAULT_TIMEOUT_SECONDS, detectProjectName } from "./plan-runtime";
export { pluginsListCommand } from "./plugins";
export {
  _promptsMainDeps,
  type ExportPromptCommandOptions,
  exportPromptCommand,
  type PromptsCommandOptions,
  type PromptsInitCommandOptions,
  promptsCommand,
  promptsInitCommand,
} from "./prompts";
export { resolveRunProfileOverride } from "./resolve-run-profile";
export {
  _routingCalibrateDeps,
  parseMinSamplesFlag,
  type RoutingCalibrateDeps,
  type RoutingCalibrateOptions,
  type RoutingCalibrateResult,
  routingCalibrateCommand,
  runRoutingCalibrateCli,
} from "./routing-calibrate";
export {
  _rulesCLIDeps,
  type MigrationOutcome,
  neutralizeContent,
  type RulesExportOptions,
  type RulesLintOptions,
  type RulesMigrateOptions,
  rulesExportCommand,
  rulesLintCommand,
  rulesMigrateCommand,
  translateLegacyFrontmatter,
  withReviewNotice,
} from "./rules";
export {
  _rulesLintDeps,
  CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS,
  collectCanonicalRuleRoots,
  DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS,
  MAX_CANONICAL_RULE_GLOB_FILES,
  MAX_DEAD_GLOB_SCAN_FILES,
  MAX_DEAD_GLOB_SCAN_TOTAL_ENTRIES,
  type RulesLintOptions as RulesLintOptionsFromLint,
  rulesLintCommand as rulesLintCommandDirect,
} from "./rules-lint";
export {
  type MigrationPlan,
  type MigrationPlanEntry,
  type PlanMigrationOptions,
  planMigration,
} from "./rules-migrate-plan";
export {
  type RunsListOptions,
  type RunsShowOptions,
  runsListCommand,
  runsShowCommand,
} from "./runs";
export { type SetupOptions, setupCommand } from "./setup";
export { _writeSetupDeps, type WriteSetupConfigResult, writeSetupConfig } from "./setup-write";
export {
  type CostReportEmitDeps,
  displayCostMetrics,
  displayFeatureStatus,
  displayLastRunMetrics,
  displayModelEfficiency,
  emitCostReportJson,
  type FeatureStatusOptions,
} from "./status";
export {
  _statusCommandActionDeps,
  _statusViewDeps,
  dispatchStatusView,
  registerStatusCommand,
  runStatusAction,
  type StatusCommandActionDeps,
  type StatusViewDeps,
  type StatusViewOptions,
} from "./status-dispatch";
