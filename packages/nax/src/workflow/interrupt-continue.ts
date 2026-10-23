/**
 * US-006: continuing an interrupted implementer turn on the still-warm session (spec §5).
 *
 * A turn cut off by its step limit comes back as `DONE_WITH_CONCERNS` with `interrupted` set, and
 * nothing told the session it was stopped. This module sends the continue turns that do, inside one
 * retry allowance shared by the whole absorbed turn — the first implement turn (with its no-work
 * restarts and advisor answers) or one fix round.
 *
 * Pure orchestration over `env`, like the rest of the loop. `runTurn` is injected because the
 * labelled turn runner lives in `story-steps.ts`, which imports this module (the `runNoWorkLadder`
 * pattern). A recovered interrupt is a ledger note only: no concern and no `(interrupted)` line.
 *
 * Spec: docs/specs/SPEC-workflow-interrupt-continue.md § US-006.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { WORKFLOW_DEFAULTS } from "@/config";
import { getLogger } from "@/logger";
import type { ImplementOutcome, ImplementTurn } from "./implement";
import { ledgerText } from "./ledger";
import type { StoryLoopEnv } from "./story-loop";

/** Which turn was cut off: the step-up it ran at and the step limit it hit. */
export interface InterruptOrigin {
  readonly stepUps: number;
  readonly limit: "implement" | "fix";
}

export interface InterruptResult {
  /** The first outcome that was not an interrupt, or the still-interrupted one when the tries ran out. */
  readonly outcome: ImplementOutcome;
  /** The attempts spent in total, across every turn this absorption ran. */
  readonly used: number;
  /** True when the outcome is still interrupted, so US-007's fallback applies to it. */
  readonly fallback: boolean;
}

type InterruptLimits = NonNullable<StoryLoopEnv["interrupt"]>;

/** The limit the origin turn was cut off by, in ms: the implement limit or the fix limit. */
function limitMsFor(limits: InterruptLimits, limit: InterruptOrigin["limit"]): number {
  return limit === "implement" ? limits.implementMs : limits.fixMs;
}

/** Whole minutes for the ledger note, never 0: a note about a 0-minute limit says nothing. */
function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** An env built before the interrupt config existed reads as `WORKFLOW_DEFAULTS` (US-005). */
function limitsFor(env: StoryLoopEnv): InterruptLimits {
  const defaults: InterruptLimits = {
    maxAttempts: WORKFLOW_DEFAULTS.interruptRetry.maxAttempts,
    implementMs: WORKFLOW_DEFAULTS.timeouts.implementMs,
    fixMs: WORKFLOW_DEFAULTS.timeouts.fixMs,
  };
  return env.interrupt ?? defaults;
}

/** A failure is never continued: it is absorbed as a session finding instead. */
function isInterrupted(outcome: ImplementOutcome): boolean {
  return !outcome.failure && outcome.reply?.interrupted === true;
}

function continuingNote(limitMinutes: number, attempt: number, maxAttempts: number): string {
  return `implementer interrupted at the step limit (${limitMinutes} min): continuing on the warm session (attempt ${attempt} of ${maxAttempts})`;
}

function costSkipNote(limitMinutes: number): string {
  return `implementer interrupted at the step limit (${limitMinutes} min): continue skipped, cost limit reached`;
}

/**
 * The files the continue prompt lists, so the warm session knows what it already did. Fail-open by
 * design: an absent step or a git failure reads as `undefined`, and the prompt tells the agent to
 * check git itself rather than claiming nothing changed.
 */
async function changedFiles(env: StoryLoopEnv): Promise<string[] | undefined> {
  const step = env.steps.workSinceBase;
  if (step === undefined) return undefined;
  try {
    return await step();
  } catch (err) {
    getLogger().warn("workflow", "Could not read the changed files for the continue turn", {
      storyId: env.storyId,
      error: errorMessage(err),
    });
    return undefined;
  }
}

interface ContinueTurnInput {
  readonly origin: InterruptOrigin;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** The continue turn for one attempt, on the origin's session, step-up and limit. */
async function continueTurnFor(env: StoryLoopEnv, input: ContinueTurnInput): Promise<ImplementTurn> {
  const files = await changedFiles(env);
  return {
    kind: "continue",
    limit: input.origin.limit,
    stepUps: input.origin.stepUps,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    ...(files !== undefined ? { changedFiles: files } : {}),
  };
}

/**
 * Continues an interrupted turn while the allowance lasts. Each attempt is skipped once the cost
 * limit is reached, and the first outcome that is not an interrupt — a reply or a failure — is
 * returned for `absorbTurn` to absorb exactly as it absorbs any other turn today.
 */
export async function continueAfterInterrupt(
  env: StoryLoopEnv,
  outcome: ImplementOutcome,
  origin: InterruptOrigin,
  used: number,
  runTurn: (turn: ImplementTurn) => Promise<ImplementOutcome>,
): Promise<InterruptResult> {
  const limits = limitsFor(env);
  const limitMinutes = minutes(limitMsFor(limits, origin.limit));
  let current = outcome;
  let attempts = used;
  while (attempts < limits.maxAttempts && isInterrupted(current)) {
    if (env.steps.costExceeded()) {
      await env.sink.ledger(ledgerText.note(costSkipNote(limitMinutes)));
      break;
    }
    attempts += 1;
    await env.sink.ledger(ledgerText.note(continuingNote(limitMinutes, attempts, limits.maxAttempts)));
    current = await runTurn(await continueTurnFor(env, { origin, attempt: attempts, maxAttempts: limits.maxAttempts }));
  }
  return { outcome: current, used: attempts, fallback: isInterrupted(current) };
}

/**
 * The one entry `absorbTurn` uses. Only an interrupted outcome continues; anything else, a failure
 * included, is handed straight back, so the absorption loop gains no branch of its own.
 */
export async function absorbInterrupt(
  env: StoryLoopEnv,
  current: ImplementOutcome,
  origin: InterruptOrigin,
  used: number,
  runTurn: (turn: ImplementTurn) => Promise<ImplementOutcome>,
): Promise<InterruptResult> {
  if (!isInterrupted(current)) return { outcome: current, used, fallback: false };
  return await continueAfterInterrupt(env, current, origin, used, runTurn);
}
