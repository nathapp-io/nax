/**
 * pickSelectorKind — selector kind dispatcher
 *
 * Determines which selector strategy to use based on explicit configuration,
 * auto-elevation heuristics (dialogue mode), and resolver fallbacks.
 */

import type { ReviewerSession } from "@/review/dialogue";
import type { ResolverContextInput } from "../session-helpers";
import type { DebateStageConfig } from "../types";

export interface PickSelectorKindContext {
  readonly reviewerSession?: ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

/**
 * Determine which selector strategy to use for a debate stage.
 *
 * Precedence:
 * 1. Explicit stageConfig.selector.kind (if present)
 * 2. Auto-elevation to 'dialogue-verdict' (when both reviewerSession and resolverContextInput are present)
 * 3. Map resolver.type to selector kind (synthesis/majority-fail-closed/majority-fail-open/judge)
 */
export function pickSelectorKind(stageConfig: DebateStageConfig, ctx: PickSelectorKindContext): string {
  // Explicit selector field wins
  if (stageConfig.selector) {
    return stageConfig.selector.kind;
  }

  // Auto-elevate to dialogue-verdict when session+context present (today's behavior)
  if (ctx.reviewerSession && ctx.resolverContextInput) {
    return "dialogue-verdict";
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

  // Fallback
  return "synthesis";
}
