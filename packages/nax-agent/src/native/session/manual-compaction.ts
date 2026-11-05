/**
 * US-002: on-demand compaction of a native session's stored history.
 *
 * Automatic compaction fires near the context limit. This is the person saying
 * the finished exploration is over — so the same pure core (`prepareCompaction`,
 * `summarizeAndApply`) runs against the stored transcript, with three deliberate
 * differences from the automatic path:
 *
 *  1. it ignores `compaction.enabled`, which governs when compaction happens BY
 *     ITSELF; asking for it is not the same decision;
 *  2. it dispatches no `before_compaction` loop event, so a plugin handler sees
 *     only proactive and overflow compactions and cannot veto or rewrite a
 *     summary the person asked for;
 *  3. it does not pin the first message. `applyCompaction` keeps `messages[0]`
 *     so a run's task prompt survives every compaction (design §Pinning, and its
 *     cache-prefix rationale); a chat exploration has no such prompt worth
 *     keeping, and the next request must BEGIN with the summary (AC-2), so the
 *     summary takes that position instead — see `applyManualCompaction`. The
 *     opening message is then part of the span (`pinFirstMessage: false`), so
 *     what it said is summarized rather than discarded with the pin.
 *
 * A summarizer failure propagates and NOTHING is written: the loaded array is a
 * fresh copy, so a rejection leaves the stored history exactly as it was.
 */
import type { Client } from "@nathapp/nax-ai";
import { NaxError } from "#src/infra/index";
import type { CompactResult } from "#src/session/agent-session-types";
import type { SessionHandle } from "#src/session/session-types";
import type { TurnDeadline } from "#src/session/turn-deadline";
import {
  COMPACTION_SUMMARY_PREFIX,
  type CompactionPlan,
  estimateContextTokens,
  estimateTokens,
  keepBudget,
  prepareCompaction,
  summaryMessage,
  type TranscriptMessage,
} from "./compaction.ts";
import type { NativeSessionState } from "./session.ts";
import { sessionTranscriptFor } from "./session.ts";
import { createSessionSummarizer, resolveSessionModel } from "./session-summarizer.ts";
import { historyFromTranscript, transcriptDocFor, transcriptIdentityFor } from "./transcript-identity.ts";
import { summarizeAndApply } from "./turn-compaction-step.ts";

/** How many trailing turns a manual compaction keeps. */
export const MANUAL_KEEP_TURNS = 1;

/**
 * Estimated tokens from the start of the `keepTurns`-th last turn to the end.
 * A turn starts at a user message that is not a compaction summary. With fewer
 * turn starts than `keepTurns`, the whole array counts.
 */
export function manualKeepTokens(messages: readonly TranscriptMessage[], keepTurns: number): number {
  let seen = 0;
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "user" || message.content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
      continue;
    }
    seen++;
    if (seen === keepTurns) {
      start = i;
      break;
    }
  }
  let total = 0;
  for (const message of messages.slice(start)) total += estimateTokens(message);
  return total;
}

/** No model call was made, so zero spend is the honest answer. */
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

export interface ManualCompactionRequest {
  /** The adapter's per-session state: transcript, model identity and saved settings all live there. */
  readonly state: NativeSessionState;
  readonly handle: SessionHandle;
  /** The session's client, supplied by the adapter that owns it. */
  readonly client: Client;
  /** The facade's budget for this call, consulted per summarizer call. */
  readonly deadline: TurnDeadline;
  /** Aborts on that deadline or on `close()`; a summarizer throw propagates instead. */
  readonly signal: AbortSignal;
}

/**
 * The manual compacted array: the summary first, then the kept window.
 *
 * Built from the plan rather than by post-processing `applyCompaction`'s array:
 * slicing its first element would be wrong the moment `applyCompaction` itself
 * drops a pin — which it does for a transcript this path already compacted.
 */
export function applyManualCompaction(
  messages: readonly TranscriptMessage[],
  plan: CompactionPlan,
  summary: string,
): TranscriptMessage[] {
  return [summaryMessage(summary), ...messages.slice(plan.cutIndex)];
}

/**
 * Compact one session's stored history now.
 *
 * Nothing is written until a plan exists and the summary has come back, so
 * "nothing to drop" costs no model call and no I/O, and a failed summary costs
 * the history nothing beyond the failed call itself.
 */
export async function compactHistory(request: ManualCompactionRequest): Promise<CompactResult> {
  const { state, handle, client, deadline, signal } = request;
  const transcript = sessionTranscriptFor(state, handle.id);
  if (transcript === undefined) {
    throw new NaxError(`no transcript store for session "${handle.id}"`, "NATIVE_TRANSCRIPT_DIR_MISSING", {
      stage: "native-session",
    });
  }
  const identity = transcriptIdentityFor(state, handle);
  // Reloaded from the store, never held in memory: the adapter keeps no
  // conversation, so what is on disk is the only history there is.
  const messages = [...historyFromTranscript(await transcript.store.load(handle.id), identity, handle.id)];
  const tokensBefore = estimateContextTokens(messages, undefined, undefined);
  const resolution = await resolveSessionModel(client, state, handle);
  // `pinFirstMessage: false`: this path writes the summary where the pin would
  // be, so the opening message has to be inside the span. Leaving it out would
  // drop the opening requirements, constraints and images without summarizing
  // them — they would reach neither the model nor the compacted transcript.
  const keep = Math.min(
    keepBudget(resolution.contextWindow, resolution.compaction),
    manualKeepTokens(messages, MANUAL_KEEP_TURNS),
  );
  const plan = prepareCompaction(messages, keep, { pinFirstMessage: false });
  if (plan === undefined) {
    return { compacted: false, tokensBefore, tokensAfter: tokensBefore, usage: ZERO_USAGE, costUsd: 0 };
  }
  const applied = await summarizeAndApply(messages, plan, {
    summarize: createSessionSummarizer({ resolution, deadline, signal }),
    contextWindow: resolution.contextWindow,
    compaction: resolution.compaction,
  });
  const compacted = applyManualCompaction(messages, plan, applied.summary.text);
  // Saved with the same owner and model identity a turn save uses, so the next
  // turn — and a resume — reads this array as its own history, not a foreign
  // one. A write failure propagates: continuing from a history that could not be
  // stored is the silent degradation ADR-028 §4 removed.
  await transcript.store.save(handle.id, transcriptDocFor(compacted, identity));
  // The anchor describes the array the provider was last charged for. Against
  // the compacted one it is meaningless, and leaving it would make the next turn
  // estimate from the OLD size and compact again straight away (AC-16).
  state.lastUsage.delete(handle.id);
  return {
    compacted: true,
    tokensBefore,
    tokensAfter: estimateContextTokens(compacted, undefined, undefined),
    usage: applied.summary.usage,
    costUsd: applied.summary.costUsd,
  };
}
