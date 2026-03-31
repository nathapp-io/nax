/**
 * Model resolution utility — AA-006
 *
 * Resolves a ModelDef from config.models.balanced with fallback chain:
 *   config value -> adapter default -> throw if none configured
 *
 * Implementation placeholder — logic to be filled in by the implementer.
 */

import { resolveModel } from "../../config/schema";
import type { ModelDef, NaxConfig } from "../../config/schema";

/**
 * Resolve the balanced model definition from config, with optional adapter default fallback.
 *
 * Fallback chain:
 * 1. config.models[defaultAgent].balanced (object or string shorthand)
 * 2. adapterDefault (if provided)
 * 3. Throws if neither is configured
 *
 * @param config - Partial NaxConfig (models and autoMode are read if present)
 * @param adapterDefault - Optional adapter-level fallback ModelDef
 * @returns Resolved ModelDef
 * @throws Error if no balanced model is configured and no adapter default provided
 */
export function resolveBalancedModelDef(
  config: Pick<NaxConfig, "models" | "autoMode"> | Partial<NaxConfig>,
  adapterDefault?: ModelDef,
): ModelDef {
  const configWithModels = config as Partial<NaxConfig>;
  const models = configWithModels.models as Record<string, Record<string, unknown>> | undefined;
  const defaultAgent = configWithModels.autoMode?.defaultAgent ?? "claude";

  // Try to get balanced tier from defaultAgent
  const balancedEntry = models?.[defaultAgent]?.balanced;

  if (balancedEntry) {
    return resolveModel(balancedEntry as string | ModelDef);
  }

  if (adapterDefault) {
    return adapterDefault;
  }

  throw new Error(
    `No balanced model configured in config.models[${defaultAgent}].balanced and no adapter default provided`,
  );
}
