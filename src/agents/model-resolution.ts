/**
 * Model resolution utility — AA-006
 *
 * Resolves a ModelDef from config.models.balanced with fallback chain:
 *   config value -> adapter default -> throw if none configured
 *
 * Implementation placeholder — logic to be filled in by the implementer.
 */

import type { ModelDef, NaxConfig } from "../config/schema";

/**
 * Resolve the balanced model definition from config, with optional adapter default fallback.
 *
 * Fallback chain:
 * 1. config.models.balanced (object or string shorthand)
 * 2. adapterDefault (if provided)
 * 3. Throws if neither is configured
 *
 * @param config - Partial NaxConfig (models.balanced is read if present)
 * @param adapterDefault - Optional adapter-level fallback ModelDef
 * @returns Resolved ModelDef
 * @throws Error if no balanced model is configured and no adapter default provided
 */
export function resolveBalancedModelDef(
  config: Pick<NaxConfig, "models"> | Partial<NaxConfig>,
  adapterDefault?: ModelDef,
): ModelDef {
  // TODO(AA-006): Implement — remove hardcoded fallbacks and resolve from config
  throw new Error("resolveBalancedModelDef not yet implemented (AA-006)");
}
