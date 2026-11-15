import type { AdapterFailure } from "@/context/engine";
import { getSafeLogger } from "@/logger";
import { parseWithoutThrowing } from "./coverage-retry";
import type { RetryContext, RetryDecision, RetryStrategy } from "./types";
import { ParseValidationError } from "./types";

/** The decision shape an exhausted strategy returns; the clarification wrapper keeps the verdict here. */
type ExhaustedDecision = Extract<RetryDecision, { retry: false }>;

export interface MismatchClarificationOpts<K extends string = string> {
  /**
   * The shape (JSON) retry. It decides from the attempt number it is handed and holds no spent
   * latch of its own, so this wrapper is what keeps a repair spent in one hop spent in the next.
   */
  readonly inner: RetryStrategy;
  /** The op's parser. The same one the inner strategy and `op.parse` run. */
  readonly parse: (output: string) => unknown;
  /** The failed kinds a parseable reply carries — empty when it is consistent, or did not parse. */
  readonly mismatch: (parsed: unknown) => readonly K[];
  /** The one clarification prompt, built for the reply whose mismatch evidence is non-empty. */
  readonly prompt: (mismatch: readonly K[]) => string;
  readonly reviewerKind: string;
  readonly _logger?: { warn(kind: string, msg: string, data: Record<string, unknown>): void };
}

function logClarification<K extends string>(
  opts: MismatchClarificationOpts<K>,
  ctx: RetryContext,
  attempt: number,
  kinds: readonly K[],
): void {
  const logger = opts._logger ?? getSafeLogger();
  logger?.warn(opts.reviewerKind, "Mismatch clarification", {
    storyId: ctx.storyId,
    kinds: kinds.join(","),
    attempt,
  });
}

/**
 * Bounded mismatch clarification (US-012): one clarification turn for the whole invocation when a
 * parseable review contradicts its own verdict, asked after shape repair and before coverage.
 *
 * The outer composition is `makeCoverageRetryStrategy(inner: this(inner: shape))`, and each wrapper
 * consults its inner first, so "shape, then clarification, then coverage" is the effect of the
 * nesting rather than a second priority table. Each wrapper subtracts the prompts it issued from the
 * attempt it passes inward, so a hop that mixes the three still tells the shape strategy how much of
 * its one-turn allowance is gone:
 *
 * - `clarified` is this wrapper's latch (at most one clarification per invocation) and is also what
 *   it subtracts. `shapeIssued` is added, not subtracted, because the shape strategy owns no latch:
 *   a manager-owned fallback hop restarts the loop at attempt 0, and without the count a spent
 *   repair would be reissued in the new hop.
 * - A null exhausted fallback is replaced by the last reply that parsed: a persistent mismatch is
 *   evidence about the review, not a reason to hand back null and certify the invocation clean.
 *
 * The instance counters are per `callOp` (the resolver runs once per invocation), which is exactly
 * the scope the one-clarification and one-shape-repair allowances are specified in. The wrapper keeps
 * no other state and reads no config.
 */
export function makeMismatchClarificationStrategy<K extends string = string>(
  opts: MismatchClarificationOpts<K>,
): RetryStrategy {
  let clarified = false;
  let shapeIssued = 0;
  let lastParseable: unknown;

  /**
   * Exhaustion hands back the last reply that parsed — findings, mismatch evidence and all — so a
   * reviewer that stayed inconsistent is reported as such instead of certifying the branch clean.
   */
  const keepLastParseable = (decision: ExhaustedDecision): RetryDecision => {
    if (lastParseable === undefined) return decision;
    if (decision.fallback !== null && decision.fallback !== undefined) return decision;
    return { retry: false, fallback: lastParseable };
  };

  return {
    shouldRetry(failure: AdapterFailure | Error, attempt: number, ctx: RetryContext): RetryDecision {
      const innerAttempt = Math.max(0, attempt - (clarified ? 1 : 0)) + shapeIssued;
      let inner: RetryDecision | undefined;
      const decideInner = (): RetryDecision => {
        inner ??= opts.inner.shouldRetry(failure, innerAttempt, ctx);
        return inner;
      };
      /** The inner retry is a shape repair, so it is one prompt of the allowance spent. */
      const shapeDecision = (): RetryDecision => {
        const decision = decideInner();
        if (decision.retry) shapeIssued += 1;
        return decision;
      };

      // A transport failure, an empty turn and an adapter-failed turn are not clarification work.
      if (!(failure instanceof ParseValidationError)) return shapeDecision();
      if (!ctx.lastOutput) return shapeDecision();
      if (ctx.lastTurnResult?.adapterFailure) return shapeDecision();

      const parsed = parseWithoutThrowing(opts.parse, ctx.lastOutput);
      if (parsed != null) lastParseable = parsed;

      const decision = shapeDecision();
      if (decision.retry) return decision;
      // A reply this wrapper cannot read has no mismatch of its own: keep the shape decision, but
      // report the last reply that did parse rather than null when the shape allowance is spent.
      if (parsed == null) return keepLastParseable(decision);

      const mismatch = opts.mismatch(parsed);
      if (mismatch.length === 0 || clarified) return decision;

      clarified = true;
      logClarification(opts, ctx, attempt, mismatch);
      return { retry: true, delayMs: 0, nextPrompt: opts.prompt(mismatch) };
    },
  };
}
