/**
 * pickSelectorKind — selector kind dispatcher
 *
 * Determines which selector strategy to use based on explicit configuration
 * and resolver fallbacks.
 */

import type { DebateStageConfig } from "../types";

/**
 * Determine which selector strategy to use for a debate stage.
 *
 * Precedence:
 * 1. Explicit stageConfig.selector.kind (if present)
 * 2. Map resolver.type to selector kind (synthesis/majority-fail-closed/majority-fail-open/judge)
 */
export function pickSelectorKind(stageConfig: DebateStageConfig): string {
  if (stageConfig.selector) {
    return stageConfig.selector.kind;
  }
  return pickBaseSelectorKind(stageConfig);
}

export function pickBaseSelectorKind(stageConfig: DebateStageConfig): string {
  switch (stageConfig.resolver.type) {
    case "synthesis":
      return "synthesis";
    case "majority-fail-closed":
      return "majority-fail-closed";
    case "majority-fail-open":
      return "majority-fail-open";
    case "custom":
      return "judge";
  }
}
