/**
 * Plugin System — Public API
 *
 * Exports all plugin types, interfaces, and loading utilities.
 */

export type {
	NaxPlugin,
	PluginType,
	PluginExtensions,
	PluginConfigEntry,
	IReviewPlugin,
	ReviewCheckResult,
	IContextProvider,
	ContextProviderResult,
	IReporter,
	RunStartEvent,
	StoryCompleteEvent,
	RunEndEvent,
} from "./types";

// Re-export optimizer types from optimizer module (via types.ts)
export type {
	IPromptOptimizer,
	PromptOptimizerInput,
	PromptOptimizerResult,
} from "./types";

export { validatePlugin } from "./validator";
export { loadPlugins } from "./loader";
export { PluginRegistry } from "./registry";
