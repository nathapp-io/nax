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
 * inner strategy (which runs the same parser) owns that shape failure. Coverage only decides
 * whether to ask again, so a throw here must not become a coverage decision.
 */
function parseOutput(parse: (output: string) => unknown, output: string): unknown {
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
 * Wraps an op's shape (and, for the bot, triage) retry and owns the file-coverage decision.
 *
 * Coverage has its own budget, separate from the inner strategy's: the inner strategy is
 * always called with `Math.max(0, attempt - issued)`, so coverage retries never spend the
 * inner budget and a hop re-run that resets `attempt` cannot push it below zero. Shape and
 * triage retries come first, coverage never retries past an inner that reports its own
 * exhaustion through `fallback`, and the budget stops as soon as a retry covers no more
 * files than the one before it.
 *
 * The strategy is resolved once per `callOp` call, so the coverage budget is per `callOp`.
 * Pulled out of #2858: a reviewer that answered "I did not read them" faced no second ask
 * because coverage shared the JSON-shape retry's `maxAttempts: 2`.
 */
export function makeCoverageRetryStrategy(opts: CoverageRetryOpts): RetryStrategy {
  let issued = 0;
  let previousUnread: number | null = null;

  return {
    shouldRetry(failure: AdapterFailure | Error, attempt: number, ctx: RetryContext): RetryDecision {
      const innerAttempt = Math.max(0, attempt - issued);
      let inner: RetryDecision | undefined;
      const decideInner = (): RetryDecision => {
        inner ??= opts.inner.shouldRetry(failure, innerAttempt, ctx);
        return inner;
      };
      const stop = (reason: StopReason, unread: number): RetryDecision => {
        logStop(opts, ctx, issued, unread, reason);
        return { retry: false, fallback: opts.exhaustedFallback(ctx.lastOutput ?? "") };
      };

      if (!(failure instanceof ParseValidationError)) return decideInner();
      if (!ctx.lastOutput) return decideInner();
      if (ctx.lastTurnResult?.adapterFailure) return decideInner();

      const parsed = parseOutput(opts.parse, ctx.lastOutput);
      if (parsed == null) return decideInner();

      const decision = decideInner();
      if (decision.retry) return decision;
      if ("fallback" in decision) return decision;

      const unread = opts.missing(parsed);
      if (unread.length === 0) return decision;
      if (issued >= opts.maxCoverageRetries) return stop("budget", unread.length);
      if (issued > 0 && previousUnread !== null && unread.length >= previousUnread) {
        return stop("no progress", unread.length);
      }

      issued += 1;
      previousUnread = unread.length;
      logRetry(opts, ctx, issued, unread.length);
      return {
        retry: true,
        delayMs: 0,
        nextPrompt: opts.prompt(unread, { attempt: issued, max: opts.maxCoverageRetries }),
      };
    },
  };
}
