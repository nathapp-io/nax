/**
 * Prompt Optimizer
 *
 * Exports optimizer types, implementations, and factory function.
 */

export type {
	IPromptOptimizer,
	PromptOptimizerInput,
	PromptOptimizerResult,
} from "./types.js";
export { estimateTokens } from "./types.js";
export { NoopOptimizer } from "./noop.optimizer.js";
export { RuleBasedOptimizer } from "./rule-based.optimizer.js";

import type { NaxConfig } from "../config/schema.js";
import type { IPromptOptimizer } from "./types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { NoopOptimizer } from "./noop.optimizer.js";
import { RuleBasedOptimizer } from "./rule-based.optimizer.js";

/**
 * Resolve the prompt optimizer to use for this run.
 *
 * Resolution order:
 * 1. Plugin-provided optimizer (if any plugins provide "optimizer")
 * 2. Built-in strategy from config (rule-based, noop)
 * 3. Fallback to NoopOptimizer
 *
 * @param config - Nax configuration
 * @param pluginRegistry - Plugin registry (optional, for plugin-provided optimizers)
 * @returns Resolved optimizer instance
 */
export function resolveOptimizer(
	config: NaxConfig,
	pluginRegistry?: PluginRegistry,
): IPromptOptimizer {
	// Check if optimizer is disabled
	if (!config.optimizer?.enabled) {
		return new NoopOptimizer();
	}

	// 1. Check plugin registry first
	if (pluginRegistry) {
		const pluginOptimizers = pluginRegistry.getOptimizers();
		if (pluginOptimizers.length > 0) {
			// Use first plugin optimizer (plugin optimizers take precedence)
			// Note: Plugin optimizer interface differs from built-in, will need adapter
			return wrapPluginOptimizer(pluginOptimizers[0]);
		}
	}

	// 2. Use built-in strategy from config
	const strategy = config.optimizer.strategy ?? "noop";

	switch (strategy) {
		case "rule-based":
			return new RuleBasedOptimizer();
		case "noop":
			return new NoopOptimizer();
		default:
			// Unknown strategy, fallback to noop
			console.warn(
				`[nax] Unknown optimizer strategy '${strategy}', using noop`,
			);
			return new NoopOptimizer();
	}
}

/**
 * Wrap a plugin optimizer to match the built-in interface.
 *
 * Plugin optimizers use a simpler interface with different field names.
 * This adapter bridges the two interfaces.
 */
function wrapPluginOptimizer(
	pluginOptimizer: import("../plugins/types.js").IPromptOptimizer,
): IPromptOptimizer {
	return {
		name: `plugin:${pluginOptimizer.name}`,
		async optimize(input) {
			// Adapt built-in input to plugin input
			const pluginInput: import("../plugins/types.js").PromptOptimizerInput =
				{
					prompt: input.prompt,
					estimatedTokens: Math.ceil(input.prompt.length / 4),
					story: input.stories[0], // Plugin interface only supports single story
				};

			// Call plugin optimizer
			const pluginResult = await pluginOptimizer.optimize(pluginInput);

			// Adapt plugin result to built-in result
			return {
				prompt: pluginResult.optimizedPrompt,
				originalTokens: pluginInput.estimatedTokens,
				optimizedTokens: pluginResult.estimatedTokens,
				savings:
					pluginInput.estimatedTokens > 0
						? pluginResult.tokensSaved / pluginInput.estimatedTokens
						: 0,
				appliedRules: pluginResult.appliedStrategies,
			};
		},
	};
}
