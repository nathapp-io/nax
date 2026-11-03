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
import { IMAGE_TOKEN_ESTIMATE } from "#src/session/image-input";
import type { AdapterInteractionResponse } from "#src/session/interaction-handler";

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
  let imageTokens = 0;
  switch (message.role) {
    case "user":
      chars = message.content.length;
      for (const image of message.images ?? []) {
        imageTokens +=
          image.width !== undefined && image.height !== undefined
            ? Math.min(IMAGE_TOKEN_ESTIMATE, Math.ceil((image.width * image.height) / 750))
            : IMAGE_TOKEN_ESTIMATE;
      }
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
  return Math.ceil(chars / CHARS_PER_TOKEN) + imageTokens;
}

/**
 * Anchor on truth, guess only the tail.
 *
 * `lastUsage.promptTokens` is every token the provider counted for the prompt
 * up to and including `anchorIndex` — uncached input plus cache reads plus
 * cache writes (see `inputClassTokens`). It is deliberately not just the
 * uncached input: under prompt caching the cached prefix is reported
 * separately, and anchoring on that one field reads a 71k-token context as
 * ~16 and silently disables compaction (nax#1852).
 *
 * With no anchor every message is estimated, which is the case the reactive
 * backstop exists to cover.
 */
export function estimateContextTokens(
  messages: readonly TranscriptMessage[],
  lastUsage?: { readonly promptTokens: number },
  anchorIndex?: number,
): number {
  if (lastUsage === undefined || anchorIndex === undefined) {
    return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  }
  let trailing = 0;
  for (let i = anchorIndex + 1; i < messages.length; i++) trailing += estimateTokens(messages[i] as TranscriptMessage);
  return lastUsage.promptTokens + trailing;
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

/**
 * Marks the summary message. The summary carries no marker FIELD: transcript
 * messages reach nax-ai structurally, so an extra property would travel to the
 * wire (the existing `denied` marker already does). Position plus this prefix
 * is how a later compaction finds the summary it must replace.
 */
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>\n";

/** Index of the pinned first message; never summarized, never dropped. */
const PIN_INDEX = 0;
/** Where the summary sits once written. */
const SUMMARY_INDEX = 1;

/** One summary message. The single place its shape is built, so both appliers agree. */
export function summaryMessage(summary: string): TranscriptMessage {
  return { role: "user", content: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX };
}

/** True when `message` is one this module wrote as a summary. */
function isSummaryMessage(message: TranscriptMessage | undefined): message is TranscriptMessage {
  return message?.role === "user" && message.content.startsWith(COMPACTION_SUMMARY_PREFIX);
}

/**
 * Valid cut points are user or assistant messages, NEVER a tool-result.
 *
 * That one rule carries both hard constraints: a tool-result can never become
 * the first kept message (orphaning it from its tool_use, which the provider
 * rejects), and cuts land between messages rather than inside an assistant
 * message, so a kept thinking block keeps its exact text and signature.
 */
function isValidCut(message: TranscriptMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

/**
 * Walk backwards accumulating estimated size; once `keepTokens` is reached, take
 * the nearest valid cut at or after that point.
 *
 * Two passes on purpose. A single backwards pass that remembers the last valid
 * index it saw returns `messages.length` whenever trailing tool-results consume
 * the whole budget before any valid cut appears — an out-of-range index the
 * caller then dereferences. Collecting the valid cuts first makes "the nearest
 * cut at or after i" answerable without that hole, and `cuts[0]` is the honest
 * default: keep everything, which `prepareCompaction` reads as "no plan".
 */
export function findCutPoint(messages: readonly TranscriptMessage[], startIndex: number, keepTokens: number): number {
  const cuts: number[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    if (isValidCut(messages[i] as TranscriptMessage)) cuts.push(i);
  }
  if (cuts.length === 0) return messages.length;

  let candidate = cuts[0] as number;
  let accumulated = 0;
  for (let i = messages.length - 1; i >= startIndex; i--) {
    accumulated += estimateTokens(messages[i] as TranscriptMessage);
    if (accumulated >= keepTokens) {
      const at = cuts.find((c) => c >= i);
      if (at !== undefined) candidate = at;
      break;
    }
  }
  return candidate;
}

export interface CompactionPlan {
  readonly cutIndex: number;
  readonly toSummarize: readonly TranscriptMessage[];
  readonly previousSummary?: string;
}

/** A summary already in the transcript: its text and the index it sits at. */
interface PreviousSummary {
  readonly text: string;
  readonly index: number;
}

/**
 * Reads a previous summary out of the transcript.
 *
 * Two positions are possible. An automatic compaction pins messages[0] and
 * writes the summary at `SUMMARY_INDEX`; a MANUAL compaction leaves no task
 * prompt to pin, so its summary sits at `PIN_INDEX` (US-002 AC-2). Both are read
 * so a second compaction MERGES instead of silently dropping the earlier
 * summary — the alternative was a manual compaction quietly losing the only
 * record of the work it shed. Newest first: after an automatic compaction on a
 * manual one, the summary further in is the merged, newer text.
 */
function readPreviousSummary(messages: readonly TranscriptMessage[]): PreviousSummary | undefined {
  for (const index of [SUMMARY_INDEX, PIN_INDEX]) {
    const candidate = messages[index];
    if (isSummaryMessage(candidate)) {
      return {
        text: candidate.content.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length),
        index,
      };
    }
  }
  return undefined;
}

export interface CompactionOptions {
  /**
   * Keep `messages[0]` out of the span and in place (the default), which is what
   * an automatic compaction does: the run's task prompt survives every compaction
   * byte-identical (design §Pinning). A MANUAL compaction passes `false` — its
   * summary takes that position (US-002 AC-2) — and must then summarize the
   * opening message, or its requirements and images reach neither the summarizer
   * nor the compacted transcript.
   */
  readonly pinFirstMessage?: boolean;
}

/**
 * Where the span to summarize begins.
 *
 * An existing summary is always excluded — it is merged, not re-summarized. With
 * none, a pinned transcript starts after `messages[0]`; an unpinned one (manual
 * compaction) starts AT it, because that message is being replaced rather than
 * kept, so leaving it out would discard it unsummarized.
 */
function spanStartFor(previous: PreviousSummary | undefined, options: CompactionOptions): number {
  if (previous !== undefined) return previous.index + 1;
  return options.pinFirstMessage === false ? PIN_INDEX : PIN_INDEX + 1;
}

export function prepareCompaction(
  messages: readonly TranscriptMessage[],
  keepTokens: number,
  options: CompactionOptions = {},
): CompactionPlan | undefined {
  const previous = readPreviousSummary(messages);
  // Everything from here is fair game; the pin, and any existing summary, are not.
  const spanStart = spanStartFor(previous, options);
  const cutIndex = findCutPoint(messages, spanStart, keepTokens);
  // An empty span is "nothing to do" whether or not a summary already exists
  // (nax#1842). A merge plan is still returnable — that needs `previousSummary`
  // AND new content, which is exactly `cutIndex > spanStart`. With an empty span
  // there is nothing to fold in: summarize() would be paid to re-summarize the
  // previous summary alone and applyCompaction would rebuild an array no smaller
  // than the one it replaced, once per round trip for the rest of the turn.
  if (cutIndex <= spanStart) return undefined;
  return {
    cutIndex,
    toSummarize: messages.slice(spanStart, cutIndex),
    ...(previous !== undefined ? { previousSummary: previous.text } : {}),
  };
}

export function applyCompaction(
  messages: readonly TranscriptMessage[],
  plan: CompactionPlan,
  summary: string,
): TranscriptMessage[] {
  // A summary AT the pin is one this session already compacted into — a manual
  // compaction writes it there (applyManualCompaction), because that path has no
  // task prompt worth pinning. Keeping it as the pin would stack two summaries,
  // the older one out of reach of the merge rule above and so never removable;
  // the new summary replaces it instead (US-002).
  const pin = isSummaryMessage(messages[PIN_INDEX]) ? [] : [messages[PIN_INDEX] as TranscriptMessage];
  return [...pin, summaryMessage(summary), ...messages.slice(plan.cutIndex)];
}
