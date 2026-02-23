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
			// Use first plugin optimizer (plugin optimizers use the same interface)
			return pluginOptimizers[0];
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

