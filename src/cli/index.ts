/**
 * CLI Utilities
 */

export { planCommand } from "./plan";
export { planDecomposeCommand, runReplanLoop } from "./plan-decompose";
export { acceptCommand, type AcceptOptions } from "./accept";
export {
  displayCostMetrics,
  displayLastRunMetrics,
  displayModelEfficiency,
  displayFeatureStatus,
  type FeatureStatusOptions,
} from "./status";
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
export { pluginsListCommand } from "./plugins";
export { diagnoseCommand, type DiagnoseOptions } from "./diagnose";
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
