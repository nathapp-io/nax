import type { AdapterFailure } from "@/context/engine";
import { getSafeLogger } from "@/logger";
import type { RetryContext, RetryDecision, RetryStrategy } from "./types";
import { ParseValidationError } from "./types";

export interface CoverageRetryOpts {
  /** The op's shape (and, for the bot, triage) retry. Its `validate` no longer checks coverage. */
  readonly inner: RetryStrategy;
  readonly parse: (output: string) => unknown;
  /** Required files the parsed verdict does not cover. */
  readonly missing: (parsed: unknown) => readonly string[];
  readonly maxCoverageRetries: number;
  readonly prompt: (missing: readonly string[], progress: { attempt: number; max: number }) => string;
  readonly exhaustedFallback: (lastOutput: string) => unknown;
  readonly reviewerKind: string;
  readonly _logger?: { warn(kind: string, msg: string, data: Record<string, unknown>): void };
}

/** Why the coverage budget stopped asking for a fuller reply. */
type StopReason = "budget" | "no progress";

/**
 * A parser that throws describes the same unusable reply as one that returns null, and the
 * inner strategy (which runs the same parser) owns that shape failure. Coverage and the mismatch
 * clarification only decide whether to ask again, so a throw here must not become their decision.
 */
export function parseWithoutThrowing(parse: (output: string) => unknown, output: string): unknown {
  try {
    return parse(output);
  } catch {
    return null;
  }
}

function logRetry(opts: CoverageRetryOpts, ctx: RetryContext, attempt: number, unread: number): void {
  const logger = opts._logger ?? getSafeLogger();
  logger?.warn(opts.reviewerKind, "Coverage retry", {
    storyId: ctx.storyId,
    unread,
    attempt,
    max: opts.maxCoverageRetries,
  });
}

function logStop(
  opts: CoverageRetryOpts,
  ctx: RetryContext,
  attempt: number,
  unread: number,
  reason: StopReason,
): void {
  const logger = opts._logger ?? getSafeLogger();
  logger?.warn(opts.reviewerKind, "Coverage retry stopped", {
    storyId: ctx.storyId,
    unread,
    attempt,
    reason,
  });
}

/**
 * The parsed reply when this turn is coverage's business at all, else `undefined`. A transport
 * failure, an empty turn, an adapter-failed turn and an unparseable reply are the inner strategy's
 * (shape or triage) to judge: coverage only decides whether a *readable* reply needs asking again.
 * The reply is wrapped so that a falsy parse result is still a reply.
 */
function coverageReply(
  opts: CoverageRetryOpts,
  failure: AdapterFailure | Error,
  ctx: RetryContext,
): { readonly parsed: unknown } | undefined {
  if (!(failure instanceof ParseValidationError)) return undefined;
  if (!ctx.lastOutput) return undefined;
  if (ctx.lastTurnResult?.adapterFailure) return undefined;
  const parsed = parseWithoutThrowing(opts.parse, ctx.lastOutput);
  return parsed == null ? undefined : { parsed };
}

/** The one exhausted decision: the op's own fallback, never an invented value. */
function exhaustedDecision(opts: CoverageRetryOpts, ctx: RetryContext): RetryDecision {
  return { retry: false, fallback: opts.exhaustedFallback(ctx.lastOutput ?? "") };
}

/**
 * A reply counts as coverage's answer only when it answers the coverage prompt still outstanding —
 * and only then is its unread count a progress measurement. A reply to a clarification or to a JSON
 * repair is neither: it measures nothing and spends nothing.
 *
 * `awaitingAnswer` is the prompt-ownership fact, and it is deliberately not the attempt number:
 * a manager-owned fallback hop restarts `sendWithParseRetry` at attempt 0 while every strategy
 * counter survives the hop, so `attempt === issuedAt + 1` can be true of a reply that answers a
 * prompt someone else issued (whole-branch review B3). The flag is cleared by anything that takes
 * the next turn away from coverage — an inner prompt, a transport failure, a hop restart.
 */
function answersCoverage(awaitingAnswer: boolean, previousUnread: number | null, unread: number): boolean {
  if (!awaitingAnswer) return false;
  return previousUnread !== null && unread >= previousUnread;
}

/**
 * Wraps an op's shape (and, for the bot, triage) retry and owns the file-coverage decision.
 *
 * Coverage has its own budget, separate from the inner strategy's: the inner strategy is
 * always called with `Math.max(0, attempt - issued)`, so coverage retries never spend the
 * inner budget and a hop re-run that resets `attempt` cannot push it below zero. Shape and
 * triage retries come first, coverage never retries past an inner that reports its own
 * exhaustion through `fallback`, and the budget stops as soon as a retry covers no more
 * files than the one before it.
 *
 * US-012: an interleaved clarification prompt makes "the reply that follows a coverage prompt"
 * and "the reply two turns later" different things, so only the turn that answers coverage's
 * outstanding prompt counts as its answer. A clarification or shape reply is none of
 * coverage's business: it measures no progress and reopens nothing, and `stopped` keeps a spent or
 * no-progress budget shut for the rest of the invocation (which outlives a manager fallback hop).
 * Prompt ownership is tracked as a flag rather than as an attempt arithmetic (whole-branch review
 * B3): attempt numbers are hop-local while every counter here survives the hop, so a hop that
 * restarts at attempt 0 after an adapter failure would otherwise let a clarification reply look
 * like the answer to the coverage prompt the previous hop issued.
 *
 * The strategy is resolved once per `callOp` call, so the coverage budget is per `callOp`.
 * Pulled out of #2858: a reviewer that answered "I did not read them" faced no second ask
 * because coverage shared the JSON-shape retry's `maxAttempts: 2`.
 */
export function makeCoverageRetryStrategy(opts: CoverageRetryOpts): RetryStrategy {
  let issued = 0;
  let previousUnread: number | null = null;
  /** The attempt at which coverage last asked, so a hop restart at a lower attempt is detectable. */
  let issuedAt: number | null = null;
  /** True while the turn now arriving is the reply to coverage's own, still-outstanding prompt. */
  let awaitingAnswer = false;
  /** Set once the budget or no-progress stopped coverage: nothing reopens it for this invocation. */
  let stopped = false;

  return {
    shouldRetry(failure: AdapterFailure | Error, attempt: number, ctx: RetryContext): RetryDecision {
      const innerAttempt = Math.max(0, attempt - issued);
      let inner: RetryDecision | undefined;
      const decideInner = (): RetryDecision => {
        inner ??= opts.inner.shouldRetry(failure, innerAttempt, ctx);
        return inner;
      };

      // Attempts only ever increase inside one hop, so a non-increasing one means a
      // manager-owned fallback hop restarted the loop: whatever coverage asked in the
      // previous hop answers nothing here.
      if (issuedAt !== null && attempt <= issuedAt) awaitingAnswer = false;

      const reply = coverageReply(opts, failure, ctx);
      if (reply === undefined) {
        // A transport failure, an empty turn or an adapter-failed turn produced no reply at
        // all, so the next turn answers whatever the inner strategy asks next — not coverage.
        awaitingAnswer = false;
        return decideInner();
      }

      const decision = decideInner();
      // This turn is the reply to the outstanding prompt (if any) and it is being spent here:
      // whichever prompt the inner strategy issues next owns the turn after it.
      const answeredCoveragePrompt = awaitingAnswer;
      awaitingAnswer = false;
      if (decision.retry) return decision;
      if ("fallback" in decision) return decision;
      if (stopped) return exhaustedDecision(opts, ctx);

      const unread = opts.missing(reply.parsed);
      if (unread.length === 0) return decision;
      if (issued >= opts.maxCoverageRetries) {
        stopped = true;
        logStop(opts, ctx, issued, unread.length, "budget");
        return exhaustedDecision(opts, ctx);
      }
      if (answersCoverage(answeredCoveragePrompt, previousUnread, unread.length)) {
        stopped = true;
        logStop(opts, ctx, issued, unread.length, "no progress");
        return exhaustedDecision(opts, ctx);
      }

      issued += 1;
      issuedAt = attempt;
      previousUnread = unread.length;
      awaitingAnswer = true;
      logRetry(opts, ctx, issued, unread.length);
      return {
        retry: true,
        delayMs: 0,
        nextPrompt: opts.prompt(unread, { attempt: issued, max: opts.maxCoverageRetries }),
      };
    },
  };
}
