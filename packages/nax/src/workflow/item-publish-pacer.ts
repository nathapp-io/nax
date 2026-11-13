/**
 * Publish-scoped pacing for the post-publish item-thread forge writes (US-001,
 * `item-publish-pacing`). One pacer per publish, holding the publish's wait budget.
 *
 * Why: a run (`2026-11-12T06-12-29`, stage `item-threads`) posted its threads about every
 * 0.5 s and GitHub answered with secondary rate limits. Every write now waits `writeGapMs`
 * after the previous one, and a write the forge *rejected* is retried (`retryBackoffMs`),
 * inside a per-publish budget of total waiting (`maxWaitMs`).
 *
 * This is a forge-write pacer inside the workflow publish step, not an agent dispatch retry:
 * `.nax/rules/retry-strategy.md` governs dispatch tiers and does not apply here.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { cancellableDelay } from "@/utils/bun-deps";

export interface ItemPublishConfig {
  /** Wait before every write except the publish's first; `writeGapMs: 0` paces nothing. */
  readonly writeGapMs: number;
  /** Wait before retrying a write the forge rejected with a retryable rejection. */
  readonly retryBackoffMs: number;
  /** Retries per write; a single write may override it through the `retries` option. */
  readonly maxRetries: number;
  /** Total waiting one publish may spend on gaps and back-offs before `write` refuses. */
  readonly maxWaitMs: number;
}

export const _itemPublishPacerDeps = {
  /** The pacer's only timer, so tests drive it without spending real time. */
  sleep: (ms: number): Promise<void> => cancellableDelay(ms),
};

export interface ItemPublishPacer {
  /** A thread post, a reopen write or a closing write. Refuses a wait that would pass the budget. */
  write<T>(action: () => Promise<T>, options?: { itemId?: string; retries?: number }): Promise<T>;
  /** An index write. Ignores the budget (never refuses, never sets `spent`), still bounded by `maxRetries`. */
  writeReserved<T>(action: () => Promise<T>, options?: { itemId?: string }): Promise<T>;
  /** True once a write was refused, or had a retry cut short, for the budget. */
  readonly spent: boolean;
}

const STAGE = "item-threads";
const BUDGET_SPENT = "ITEM_PUBLISH_BUDGET_SPENT";
const RETRY_WARN = "[item-threads] Write rejected; retrying after back-off";

/**
 * The forge rejections a retry cannot duplicate: the write was refused, so nothing landed.
 * A 5xx, a timeout, an auth failure or an unparseable reply may mean it did land, and
 * `runForgeWrite` must never repeat a write that may have completed.
 */
const RETRYABLE_STDERR = ["rate limit", "http 429", "http 422"];

export function isRetryableRejection(error: unknown): boolean {
  if (!(error instanceof NaxError) || error.code !== "FORGE_COMMENT_WRITE_FAILED") return false;
  const stderr = error.context?.stderr;
  if (typeof stderr !== "string") return false;
  const lower = stderr.toLowerCase();
  return RETRYABLE_STDERR.some((needle) => lower.includes(needle));
}

interface PacerState {
  /** Gap and back-off waits this publish has taken, in milliseconds. */
  waitedMs: number;
  spent: boolean;
  /** Any write of the publish has started, so only the first one skips the gap. */
  started: boolean;
}

function budgetError(config: ItemPublishConfig, state: PacerState, neededMs: number, itemId?: string): NaxError {
  return new NaxError(
    `[${STAGE}] Item publish wait budget spent: ${neededMs} ms more would pass ${config.maxWaitMs} ms after ${state.waitedMs} ms`,
    BUDGET_SPENT,
    {
      stage: STAGE,
      ...(itemId === undefined ? {} : { itemId }),
      neededMs,
      waitedMs: state.waitedMs,
      maxWaitMs: config.maxWaitMs,
    },
  );
}

function warnRetrying(itemId: string | undefined, attempt: number, error: unknown): void {
  getLogger().warn(STAGE, RETRY_WARN, {
    ...(itemId === undefined ? {} : { itemId }),
    attempt,
    error: errorMessage(error),
  });
}

/**
 * Take one wait, adding it to the publish's total. Returns false only when a `write` wait
 * would pass the budget: the caller refuses without waiting.
 */
async function takeWait(state: PacerState, config: ItemPublishConfig, ms: number, reserved: boolean): Promise<boolean> {
  // A write that needs no wait always runs, even after a reserved write has carried the total
  // past the budget.
  if (ms <= 0) return true;
  if (!reserved && state.waitedMs + ms > config.maxWaitMs) {
    state.spent = true;
    return false;
  }
  await _itemPublishPacerDeps.sleep(ms);
  state.waitedMs += ms;
  return true;
}

async function payGap(
  state: PacerState,
  config: ItemPublishConfig,
  reserved: boolean,
  itemId: string | undefined,
): Promise<void> {
  const first = !state.started;
  state.started = true;
  if (first) return;
  if (await takeWait(state, config, config.writeGapMs, reserved)) return;
  throw budgetError(config, state, config.writeGapMs, itemId);
}

async function runPaced<T>(
  state: PacerState,
  config: ItemPublishConfig,
  action: () => Promise<T>,
  options: { itemId?: string; retries?: number },
  reserved: boolean,
): Promise<T> {
  const { itemId } = options;
  const retries = options.retries ?? config.maxRetries;
  await payGap(state, config, reserved, itemId);
  for (let retry = 0; ; retry++) {
    try {
      return await action();
    } catch (error) {
      if (retry >= retries || !isRetryableRejection(error)) throw error;
      // A budget refusal before a retry rethrows the rejection: the write stays unretried.
      if (!(await takeWait(state, config, config.retryBackoffMs, reserved))) throw error;
      warnRetrying(itemId, retry + 1, error);
    }
  }
}

export function createItemPublishPacer(config: ItemPublishConfig): ItemPublishPacer {
  const state: PacerState = { waitedMs: 0, spent: false, started: false };
  /** The last queued write, settled either way: a refused write must not stall the queue. */
  let tail: Promise<unknown> = Promise.resolve();

  /**
   * Run one write at a time. A gap only spaces writes that follow one another, so two writes
   * started together would otherwise sleep together and then hit the forge together — the very
   * burst this pacer exists to prevent — and both would read the same `waitedMs`.
   */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    write: (action, options = {}) => enqueue(() => runPaced(state, config, action, options, false)),
    writeReserved: (action, options = {}) => enqueue(() => runPaced(state, config, action, options, true)),
    get spent() {
      return state.spent;
    },
  };
}
