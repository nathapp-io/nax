/**
 * CLI Utilities
 */

export { analyzeFeature } from "./analyze";
export { planCommand } from "./plan";
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
  type PromptsCommandOptions,
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
