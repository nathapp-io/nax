/**
 * Per-Package Config Merge Utility (MW-008)
 *
 * Only quality.commands is mergeable — routing, plugins, execution,
 * and agents stay root-only.
 */

import type { NaxConfig } from "./schema";

/**
 * Merge a package-level partial config override into a root config.
 *
 * Only quality.commands keys are merged. All other sections remain
 * unchanged from the root config.
 *
 * @param root - Full root NaxConfig (already validated)
 * @param packageOverride - Partial package-level override (only quality.commands honored)
 * @returns New merged NaxConfig (immutable — does not mutate inputs)
 */
export function mergePackageConfig(root: NaxConfig, packageOverride: Partial<NaxConfig>): NaxConfig {
  const packageCommands = packageOverride.quality?.commands;

  if (!packageCommands) {
    return root;
  }

  return {
    ...root,
    quality: {
      ...root.quality,
      commands: {
        ...root.quality.commands,
        ...packageCommands,
      },
    },
  };
}
