/**
 * Prompt Optimizer
 *
 * Exports optimizer types, implementations, and factory function.
 */

export { NoopOptimizer } from "./noop.optimizer.js";
export type {
  IPromptOptimizer,
  PromptOptimizerInput,
  PromptOptimizerResult,
} from "./types.js";
export { estimateTokens } from "./types.js";

import type { NaxConfig } from "../config/schema.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { NoopOptimizer } from "./noop.optimizer.js";
import type { IPromptOptimizer } from "./types.js";

/**
 * Resolve the prompt optimizer to use for this run.
 *
 * Resolution order:
 * 1. Plugin-provided optimizer (if any plugins provide "optimizer")
 * 2. NoopOptimizer (pass-through)
 *
 * The `rule-based` built-in was removed: no config in the life of the repo ever
 * selected it, and its per-rule `optimizer.strategies` block was absent from the
 * Zod schema, so it was unconfigurable even when opted into. Anything beyond
 * pass-through now arrives as a plugin via `IPromptOptimizer`.
 *
 * @param config - Nax configuration
 * @param pluginRegistry - Plugin registry (optional, for plugin-provided optimizers)
 * @returns Resolved optimizer instance
 */
export function resolveOptimizer(config: NaxConfig, pluginRegistry?: PluginRegistry): IPromptOptimizer {
  if (!config.optimizer?.enabled) {
    return new NoopOptimizer();
  }

  const pluginOptimizers = pluginRegistry?.getOptimizers() ?? [];
  if (pluginOptimizers.length > 0) {
    // Plugin optimizers use the same interface as the built-in.
    return pluginOptimizers[0];
  }

  return new NoopOptimizer();
}
