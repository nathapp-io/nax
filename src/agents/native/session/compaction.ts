/**
 * Context compaction for the native turn loop.
 *
 * Pure functions only: no file I/O, no model calls, no clock. turn-loop.ts owns
 * the orchestration and the one model call. Keeping this half pure is what makes
 * the cut-point rules testable directly rather than only end to end.
 *
 * See docs/superpowers/specs/2026-09-04-native-context-compaction-design.md.
 */

import type { ConversationMessage } from "@nathapp/nax-ai";
import type { AdapterInteractionResponse } from "@/agents";

/**
 * The transcript message nax stores: nax-ai's ConversationMessage widened with
 * the coding-tool denial marker (ADR-029 s5). The marker is structural data the
 * model must be able to act on — dropping it because the wire type does not
 * know it yet is exactly the defect this widening exists to prevent.
 *
 * Lives here rather than in turn-loop.ts because both modules need it and this
 * is the one without a dependency on the other.
 */
export type TranscriptMessage =
  | ConversationMessage
  | {
      readonly role: "tool-result";
      readonly toolCallId: string;
      readonly content: string;
      readonly isError?: boolean;
      readonly denied?: AdapterInteractionResponse["denied"];
    };

/** Compaction settings after config resolution. Reaches the adapter as a primitive. */
export interface ResolvedCompaction {
  readonly enabled: boolean;
  readonly compactAtPercent: number;
  readonly keepRecentPercent: number;
}

/** A reply needs room whatever the window is. */
const MIN_HEADROOM_TOKENS = 4096;
/** ...but never take a quarter of a small window for headroom. */
const MAX_HEADROOM_FRACTION = 0.25;
const CHARS_PER_TOKEN = 4;

/**
 * Characters over four. Deliberately crude and deliberately high: over-estimating
 * compacts slightly early, under-estimating overflows.
 */
export function estimateTokens(message: TranscriptMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
      chars = message.content.length;
      break;
    case "assistant":
      chars = message.content.length;
      for (const block of message.thinking ?? []) chars += block.text.length;
      for (const call of message.toolCalls ?? []) chars += call.name.length + JSON.stringify(call.input).length;
      break;
    case "tool-result":
      chars = message.content.length;
      break;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Anchor on truth, guess only the tail.
 *
 * `lastUsage.inputTokens` is what the provider actually charged for everything
 * up to and including `anchorIndex`, so only messages after it are estimated.
 * With no anchor every message is estimated, which is the case the reactive
 * backstop exists to cover.
 */
export function estimateContextTokens(
  messages: readonly TranscriptMessage[],
  lastUsage?: { readonly inputTokens: number },
  anchorIndex?: number,
): number {
  if (lastUsage === undefined || anchorIndex === undefined) {
    return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  }
  let trailing = 0;
  for (let i = anchorIndex + 1; i < messages.length; i++) trailing += estimateTokens(messages[i] as TranscriptMessage);
  return lastUsage.inputTokens + trailing;
}

/**
 * The percentage governs; the floor only takes over when a percentage of the
 * window would leave too little room for a reply. Both constants are a safety
 * rail against a window smaller than the defaults assume, not tuning knobs —
 * which is why they are not config.
 */
export function compactionThreshold(window: number, cfg: ResolvedCompaction): number {
  const headroom = Math.min(MIN_HEADROOM_TOKENS, Math.floor(window * MAX_HEADROOM_FRACTION));
  return Math.min(Math.floor(window * (cfg.compactAtPercent / 100)), window - headroom);
}

export function shouldCompact(tokens: number, window: number, cfg: ResolvedCompaction): boolean {
  return cfg.enabled && tokens > compactionThreshold(window, cfg);
}

/**
 * How much recent conversation survives verbatim, in tokens.
 * `aggressive` halves it — the reactive backstop's only difference.
 */
export function keepBudget(window: number, cfg: ResolvedCompaction, aggressive = false): number {
  const budget = Math.floor(window * (cfg.keepRecentPercent / 100));
  return aggressive ? Math.floor(budget / 2) : budget;
}
