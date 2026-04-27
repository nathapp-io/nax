import type { PipelineStage } from "../config/permissions";
import type { StoryLogger } from "../logger/types";

type LoopLogger = Pick<StoryLogger, "debug" | "error" | "info" | "warn"> | null;

/**
 * One completed attempt in a retry loop — passed to buildPrompt as previousAttempts
 * so callers can compose progressive escalation prompts.
 */
export interface RetryAttempt<TResult> {
  readonly attempt: number;
  readonly result: TResult;
}

/**
 * Outcome from verify() — either passed or failed with a new failure snapshot
 * (the updated failures from re-running verification).
 */
export type VerifyOutcome<TFailure> =
  | { readonly passed: true }
  | { readonly passed: false; readonly newFailure: TFailure };

/**
 * Outcome from runRetryLoop() — either fixed (with the result that passed verify)
 * or exhausted (all maxAttempts consumed without a passing verify).
 */
export type RetryOutcome<TResult> =
  | { readonly outcome: "fixed"; readonly result: TResult; readonly attempts: number }
  | { readonly outcome: "exhausted"; readonly attempts: number };

/**
 * Unified retry-loop input — ADR-018 §8.
 *
 * Purely functional: no mutable state, no callbacks with side-effect signatures.
 * Progressive composition lives inside buildPrompt() via composeSections().
 */
export interface RetryInput<TFailure, TResult> {
  /** Pipeline stage for logging. */
  readonly stage: PipelineStage;
  /** Story ID for log correlation. */
  readonly storyId: string;
  /** Package directory for log correlation. */
  readonly packageDir: string;
  /** Maximum number of attempts (inclusive). */
  readonly maxAttempts: number;
  /** Initial failure snapshot (before any attempts). */
  readonly failure: TFailure;
  /** Accumulated results from prior attempts (empty on first call). */
  readonly previousAttempts: ReadonlyArray<RetryAttempt<TResult>>;
  /**
   * Build the prompt for this attempt.
   * Receives the current failure snapshot and all previous attempt results.
   * Called once per attempt before execute().
   * May be async (e.g., to build complex prompts with external calls).
   */
  readonly buildPrompt: (failure: TFailure, previous: readonly RetryAttempt<TResult>[]) => Promise<string> | string;
  /**
   * Execute one attempt (agent run, etc.) and return a result.
   * Receives the prompt built by buildPrompt().
   */
  readonly execute: (prompt: string) => Promise<TResult>;
  /**
   * Verify the result of this attempt.
   * Returns { passed: true } on success, or { passed: false, newFailure } with
   * an updated failure snapshot for the next attempt's buildPrompt.
   */
  readonly verify: (result: TResult) => Promise<VerifyOutcome<TFailure>>;
}

export interface ProgressivePromptPreambleOptions {
  attempt: number;
  maxAttempts: number;
  rethinkAtAttempt?: number;
  urgencyAtAttempt?: number;
  stage: string;
  logger?: LoopLogger;
  rethinkSection: string;
  urgencySection: string;
}

export function buildProgressivePromptPreamble(opts: ProgressivePromptPreambleOptions): string {
  const rethinkAt = Math.min(opts.rethinkAtAttempt ?? 2, opts.maxAttempts);
  const urgencyAt = Math.min(opts.urgencyAtAttempt ?? 3, opts.maxAttempts);
  const shouldRethink = opts.attempt >= rethinkAt;
  const shouldUrgency = opts.attempt >= urgencyAt;

  if (!shouldRethink && !shouldUrgency) {
    return "";
  }

  if (shouldUrgency) {
    opts.logger?.info(opts.stage, "Progressive prompt escalation: urgency + rethink injected", {
      attempt: opts.attempt,
      rethinkAtAttempt: rethinkAt,
      urgencyAtAttempt: urgencyAt,
      maxAttempts: opts.maxAttempts,
    });
  } else {
    opts.logger?.info(opts.stage, "Progressive prompt escalation: rethink injected", {
      attempt: opts.attempt,
      rethinkAtAttempt: rethinkAt,
      maxAttempts: opts.maxAttempts,
    });
  }

  const urgencySection = shouldUrgency ? opts.urgencySection : "";
  const rethinkSection = shouldRethink ? opts.rethinkSection : "";
  return `${urgencySection}${rethinkSection}`;
}

/**
 * Unified retry loop — ADR-018 §8.
 *
 * Runs up to maxAttempts iterations of: buildPrompt → execute → verify.
 * Passes accumulated previousAttempts to buildPrompt for progressive escalation.
 * Returns fixed (with the passing result) or exhausted (all attempts consumed).
 */
export async function runRetryLoop<TFailure, TResult>(
  input: RetryInput<TFailure, TResult>,
): Promise<RetryOutcome<TResult>> {
  let currentFailure = input.failure;
  const previous: RetryAttempt<TResult>[] = [...input.previousAttempts];

  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    const prompt = await Promise.resolve(input.buildPrompt(currentFailure, previous));
    const result = await input.execute(prompt);
    const outcome = await input.verify(result);
    previous.push({ attempt, result });

    if (outcome.passed) {
      return { outcome: "fixed", result, attempts: attempt };
    }
    currentFailure = outcome.newFailure;
  }

  return { outcome: "exhausted", attempts: input.maxAttempts };
}
