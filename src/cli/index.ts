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
  type PromptsCommandOptions,
  type PromptsInitCommandOptions,
  type ExportPromptCommandOptions,
} from "./prompts";
export { initCommand, type InitOptions } from "./init";
export { setupCommand, type SetupOptions } from "./setup";
export { writeSetupConfig, _writeSetupDeps, type WriteSetupConfigResult } from "./setup-write";
export { pluginsListCommand } from "./plugins";
export {
  interactListCommand,
  interactRespondCommand,
  interactCancelCommand,
  type InteractListOptions,
  type InteractRespondOptions,
  type InteractCancelOptions,
} from "./interact";
export { generateCommand, type GenerateCommandOptions } from "./generate";
export { configCommand, type ConfigCommandOptions } from "./config";
export { agentsListCommand } from "./agents";
export { contextInspectCommand, type ContextInspectOptions } from "./context";
export {
  rulesExportCommand,
  rulesLintCommand,
  rulesMigrateCommand,
  neutralizeContent,
  type RulesExportOptions,
  type RulesLintOptions,
  type RulesMigrateOptions,
} from "./rules";
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
