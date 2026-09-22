/**
 * The two compaction steps of the native turn loop.
 *
 * `runProactiveCompaction` runs before a round trip when the estimate crosses
 * the threshold; `runOverflowCompaction` is the backstop when a round trip
 * throws a context overflow anyway. They are deliberately TWO functions, not one
 * with a `reactive` flag, because they differ in exactly three ways a boolean
 * would hide:
 *
 *   1. the backstop halves the keep budget (`keepBudget(..., true)`);
 *   2. a summarizer throw is swallowed by the proactive step (the request may
 *      still fit) and propagates out of the backstop;
 *   3. only the proactive step logs its progress (Finding 2, whole-branch
 *      review 2026-09-04).
 *
 * They share only the summarize-and-apply core below. The failure semantics
 * stay with the callers on purpose — see each function's catch.
 */

import { getSafeLogger } from "@/logger";
import {
  applyCompaction,
  type CompactionPlan,
  estimateContextTokens,
  keepBudget,
  type TranscriptMessage as NativeTranscriptMessage,
  prepareCompaction,
} from "./compaction";
import { type TurnAccumulator, usageBeat } from "./turn-accumulator";
import type { NativeSummaryResponse, TurnDeps } from "./turn-types";

/**
 * The compaction dependencies, with the three the step cannot run without
 * required. `TurnDeps` has them optional (absent disables compaction); the call
 * site narrows them to defined with the guard before calling, and requiring them
 * here is what carries that narrowing into this module.
 */
export interface CompactionStepDeps {
  readonly summarize: NonNullable<TurnDeps["summarize"]>;
  readonly contextWindow: NonNullable<TurnDeps["contextWindow"]>;
  readonly compaction: NonNullable<TurnDeps["compaction"]>;
  readonly onActivity?: TurnDeps["onActivity"];
  readonly deadline?: TurnDeps["deadline"];
}

export interface CompactionStepArgs {
  readonly messages: readonly NativeTranscriptMessage[];
  readonly usage: TurnAccumulator;
  readonly sessionName: string;
  readonly lastUsage: { readonly promptTokens: number } | undefined;
  readonly anchorIndex: number | undefined;
  readonly deps: CompactionStepDeps;
  readonly signal?: AbortSignal;
}

export interface CompactionStepResult {
  readonly messages: readonly NativeTranscriptMessage[];
  /** True when the array was rebound, so the caller clears lastUsage/anchorIndex. */
  readonly compacted: boolean;
  /** Proactive only: the summarizer threw, so the overflow retry must not try again. */
  readonly summarizeFailed: boolean;
}

export interface OverflowCompactionArgs extends CompactionStepArgs {
  /**
   * The original context-overflow error. `prepareCompaction` returning undefined
   * means there is nothing safe left to drop, so it is rethrown verbatim —
   * tests and the failure-usage ledger key on the error's own identity.
   */
  readonly error: unknown;
}

interface AppliedSummary {
  readonly messages: readonly NativeTranscriptMessage[];
  readonly summary: NativeSummaryResponse;
}

/**
 * The half both branches share: summarize the dropped span, then apply the
 * summary to the transcript. A throw here is left to propagate — catching it is
 * the proactive caller's decision, not this function's.
 */
async function summarizeAndApply(
  messages: readonly NativeTranscriptMessage[],
  plan: CompactionPlan,
  deps: CompactionStepDeps,
): Promise<AppliedSummary> {
  const summary = await deps.summarize(plan.toSummarize, plan.previousSummary);
  // Rebound, not spliced in place: `messages` is a local accumulator and
  // rebinding it keeps the compacted array a fresh value.
  const compacted = applyCompaction(messages, plan, summary.text);
  return { messages: compacted, summary };
}

export async function runProactiveCompaction(args: CompactionStepArgs): Promise<CompactionStepResult> {
  const { messages, usage, sessionName, lastUsage, anchorIndex, deps, signal } = args;
  const preCompactionTokens = estimateContextTokens(messages, lastUsage, anchorIndex);
  const plan = prepareCompaction(messages, keepBudget(deps.contextWindow, deps.compaction));
  if (plan === undefined) {
    return { messages, compacted: false, summarizeFailed: false };
  }
  try {
    const applied = await summarizeAndApply(messages, plan, deps);
    // Finding 2 (whole-branch review, 2026-09-04): a previous-summary merge
    // can produce a same-size (or larger) array — a paid model call that
    // shrank nothing. Not fatal (the reactive backstop is the real safety
    // net if this repeats into an overflow) but worth surfacing, since it
    // would otherwise burn a model call every round trip with no signal.
    const postCompactionTokens = estimateContextTokens(applied.messages, undefined, undefined);
    if (postCompactionTokens >= preCompactionTokens) {
      getSafeLogger()?.warn("native-adapter", "compaction made no size progress", {
        sessionName,
        preCompactionTokens,
        postCompactionTokens,
      });
    }
    getSafeLogger()?.info("native-adapter", "compaction completed", {
      sessionName,
      // Keep token counts under the plural `tokens` metric key so the
      // logger's credential redactor does not mistake them for secrets.
      tokens: { before: preCompactionTokens, after: postCompactionTokens },
      messagesDropped: plan.toSummarize.length,
      summaryLength: applied.summary.text.length,
    });
    usage.add(applied.summary.usage, applied.summary.costUsd, applied.summary.rates);
    // Resets the watchdog's lastActivityAt between the summary and the
    // round trip, so the two silent spans do not add up against one budget.
    deps.onActivity?.(usageBeat(applied.summary.usage, applied.summary.costUsd));
    return { messages: applied.messages, compacted: true, summarizeFailed: false };
  } catch (err) {
    if (deps.deadline?.expired() === true || signal?.aborted === true) throw err;
    // Not fatal: the request may still fit, and if it does not it fails
    // through the path #1837 and #1839 made correct. Killing a story
    // because a summarizer hiccuped would be worse than the problem.
    getSafeLogger()?.warn("native-adapter", "compaction summary failed; sending uncompacted", {
      sessionName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messages, compacted: false, summarizeFailed: true };
  }
}

export async function runOverflowCompaction(args: OverflowCompactionArgs): Promise<CompactionStepResult> {
  const { messages, usage, deps, error } = args;
  // Same code path, half the keep budget. Not a second algorithm.
  const plan = prepareCompaction(messages, keepBudget(deps.contextWindow, deps.compaction, true));
  if (plan === undefined) throw error;
  const applied = await summarizeAndApply(messages, plan, deps);
  usage.add(applied.summary.usage, applied.summary.costUsd, applied.summary.rates);
  deps.onActivity?.(usageBeat(applied.summary.usage, applied.summary.costUsd));
  return { messages: applied.messages, compacted: true, summarizeFailed: false };
}
