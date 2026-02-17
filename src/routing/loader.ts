/**
 * Custom Strategy Loader
 *
 * Dynamically imports custom routing strategies from user-provided paths.
 */

import { resolve } from "node:path";
import type { RoutingStrategy } from "./strategy";

/**
 * Load a custom routing strategy from a file path.
 *
 * The custom strategy file must export a default object that satisfies
 * the RoutingStrategy interface.
 *
 * @param strategyPath - Path to the custom strategy file (relative to project root or absolute)
 * @param workdir - Working directory (project root)
 * @returns Loaded routing strategy
 * @throws Error if the strategy cannot be loaded or is invalid
 *
 * @example
 * ```ts
 * const strategy = await loadCustomStrategy("./my-router.ts", process.cwd());
 * const decision = strategy.route(story, context);
 * ```
 */
export async function loadCustomStrategy(
  strategyPath: string,
  workdir: string,
): Promise<RoutingStrategy> {
  const absolutePath = resolve(workdir, strategyPath);

  try {
    // Dynamic import (works with both .ts and .js files in Bun)
    const module = await import(absolutePath);

    // Expect default export
    const strategy = module.default;

    if (!strategy) {
      throw new Error(
        `Custom strategy at ${absolutePath} does not have a default export`
      );
    }

    // Validate strategy interface
    if (typeof strategy.name !== "string") {
      throw new Error(
        `Custom strategy at ${absolutePath} is missing 'name' property`
      );
    }

    if (typeof strategy.route !== "function") {
      throw new Error(
        `Custom strategy at ${absolutePath} is missing 'route' method`
      );
    }

    return strategy as RoutingStrategy;
  } catch (error) {
    throw new Error(
      `Failed to load custom routing strategy from ${absolutePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
