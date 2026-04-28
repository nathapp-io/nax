/**
 * Interaction Bridge Builder
 *
 * Shared utility to build an `interactionBridge` object from an `InteractionChain`.
 * Used by pipeline stages and the TDD orchestrator to thread interaction Q&A
 * consistently, without duplicating bridge-building logic.
 */

import type { InteractionChain } from "./chain";
import type { InteractionStage } from "./types";

/** Shape expected by AgentRunOptions.interactionBridge */
export interface InteractionBridge {
  detectQuestion: (text: string) => Promise<boolean>;
  onQuestionDetected: (text: string) => Promise<string>;
}

/** Context metadata attached to interaction events */
export interface BridgeContext {
  featureName?: string;
  storyId?: string;
  /** Must be a valid InteractionStage value */
  stage: InteractionStage;
}

// @design: BUG-097: Use /\?\s*$/ instead of /\?/ to avoid false positives on code (?., ??, ternary)
const QUESTION_PATTERNS = [/\?\s*$/, /\bwhich\b/i, /\bshould i\b/i, /\bunclear\b/i, /\bplease clarify\b/i];

/** Default interaction timeout when config value is not available (2 minutes) */
const DEFAULT_INTERACTION_TIMEOUT_MS = 120_000;

/**
 * Build an interactionBridge from an InteractionChain.
 *
 * Returns `undefined` when no plugin is available (chain is null/undefined or
 * `getPrimary()` returns null), which causes the ACP adapter to run in single-turn
 * mode (MAX_TURNS = 1).
 *
 * @param chain - Initialized InteractionChain (or null/undefined)
 * @param context - Metadata attached to interaction events
 * @param timeoutMs - How long to wait for a human response (default 120s)
 */
export function buildInteractionBridge(
  chain: InteractionChain | null | undefined,
  context: BridgeContext,
  timeoutMs: number = DEFAULT_INTERACTION_TIMEOUT_MS,
): InteractionBridge | undefined {
  const plugin = chain?.getPrimary();
  if (!plugin) return undefined;

  return {
    detectQuestion: async (text: string): Promise<boolean> => QUESTION_PATTERNS.some((p) => p.test(text)),

    onQuestionDetected: async (text: string): Promise<string> => {
      const requestId = `ix-${context.stage}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      await plugin.send({
        id: requestId,
        type: "input",
        featureName: context.featureName ?? "unknown",
        storyId: context.storyId,
        stage: context.stage,
        summary: text,
        fallback: "continue",
        createdAt: Date.now(),
      });
      try {
        const response = await plugin.receive(requestId, timeoutMs);
        return response.value ?? "continue";
      } catch {
        return "continue";
      }
    },
  };
}
