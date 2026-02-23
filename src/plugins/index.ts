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
	IPromptOptimizer,
	PromptOptimizerInput,
	PromptOptimizerResult,
	IReviewPlugin,
	ReviewCheckResult,
	IContextProvider,
	ContextProviderResult,
	IReporter,
	RunStartEvent,
	StoryCompleteEvent,
	RunEndEvent,
} from "./types";

export { validatePlugin } from "./validator";
export { loadPlugins } from "./loader";
export { PluginRegistry } from "./registry";
