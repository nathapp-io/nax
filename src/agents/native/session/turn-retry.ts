/**
 * Bounded transport-fault retry for the native turn loop (nax#1870).
 *
 * A mid-stream provider stall (OpenRouter's "Upstream idle timeout exceeded",
 * a bare 502/503) surfaces to `runNativeTurn` as a throw from `deps.complete`.
 * Retrying it here is safe, and safe nowhere else:
 *
 * - `@nathapp/nax-ai`'s own retry (protocols/retry.ts, same repo family as
 *   this file — its doc comments are this file's model) is gated on
 *   `emitted`: the moment any event is yielded, retry is off for that
 *   attempt, because retrying past a `usage` event would double-bill. A
 *   mid-stream stall is therefore structurally out of its reach.
 * - A run-kind op's declarative `retry` (`sendWithParseRetry`,
 *   src/operations/call.ts) has no try/catch around the call at all — a
 *   transport throw propagates straight past it, untouched.
 * - The turn loop can, cheaply: on a throw from `deps.complete`, `messages`
 *   is unchanged (the failed response was never appended) and no tool from
 *   that round trip has executed (tools run only after `complete` returns),
 *   so an immediate re-issue costs one round trip against the alternative of
 *   discarding the whole session.
 *
 * This is the native counterpart to `agent.acp.promptRetries`: acpx's
 * spawned process absorbs a provider stall before nax ever observes it;
 * native has no such process, so nax is the harness that must.
 *
 * Detection is structural, matching turn-loop.ts's `isContextOverflow` and
 * adapter.ts's `isProtocolStreamError`: nax-ai's error class is not
 * importable outside src/agents/native/ (check-nax-ai-imports.ts), so only
 * the shape — a `protocolError.kind` string — is inspected, never the class.
 */

/** Total call attempts including the first (2 = one retry, 3 = two retries). */
export interface TurnRetryConfig {
  readonly maxAttempts: number;
  /** Base delay for exponential backoff with jitter, in ms, when the provider gives no retryAfter. */
  readonly baseDelayMs: number;
}

/** The minimal shape this module reads off a thrown protocol fault. */
interface RetryableProtocolError {
  readonly protocolError: {
    readonly kind: string;
    /** Seconds, when the provider signals one (nax-ai types.ts ProtocolError.retryAfter). */
    readonly retryAfter?: number;
  };
}

/**
 * Kinds this module retries. "auth" and "bad-request" are terminal —
 * retrying cannot help. "rate-limit" is consumer policy handled elsewhere
 * (the manager-tier `defaultRetryStrategy`, and nax-ai's own doc comment
 * makes the same call) — retrying it here would double-retry against that.
 * "context-overflow" keeps its existing, dedicated compaction-retry path in
 * turn-loop.ts and must never be handled here.
 */
const RETRYABLE_KINDS = new Set(["transport", "overloaded"]);

export function isRetryableTransportFault(err: unknown): err is RetryableProtocolError {
  if (typeof err !== "object" || err === null || !("protocolError" in err)) return false;
  const { protocolError } = err as { protocolError?: { kind?: unknown } };
  return typeof protocolError?.kind === "string" && RETRYABLE_KINDS.has(protocolError.kind);
}

/** Whether another attempt is allowed at all, independent of the error's kind. */
export function canAttemptTurnRetry(retryIndex: number, config: TurnRetryConfig): boolean {
  return retryIndex < config.maxAttempts - 1;
}

/**
 * Equal jitter (AWS's "Exponential Backoff And Jitter"): half of
 * `base * 2^retryIndex` fixed, half uniformly random, so concurrent retries
 * spread out instead of synchronising on the same step while still keeping a
 * floor. Full jitter's [0, ceiling] range was rejected: its lower bound lets
 * a retry re-issue almost instantly against a provider that has just stalled
 * or reported itself overloaded, which is the one thing backoff exists to
 * avoid. nax-ai's own retry.ts omits jitter entirely because it hands
 * concurrency policy to its consumer — this module IS that consumer, so the
 * jitter belongs here.
 */
function backoffMs(retryIndex: number, baseDelayMs: number, random: () => number): number {
  const half = (baseDelayMs * 2 ** retryIndex) / 2;
  return Math.floor(half + random() * half);
}

/**
 * How long to wait before the next attempt. The provider's own `retryAfter`
 * wins when set — it knows its own recovery time better than a guessed
 * backoff does — otherwise equal-jitter exponential backoff from
 * `baseDelayMs`.
 *
 * `remainingMs` caps whatever that produces. A 503 can advertise a recovery
 * window far longer than the turn has left, and sleeping it out would spend
 * wall clock the budget has already declared gone — the attempt after it
 * aborts immediately anyway, because TurnDeadline.remainingMs() clamps to 0
 * and adapter.ts arms the call's AbortController with it. Absent means the
 * turn is unbounded (TurnDeadline's UNBOUNDED), so nothing caps the wait.
 */
export function turnRetryDelayMs(
  err: RetryableProtocolError,
  retryIndex: number,
  config: TurnRetryConfig,
  random: () => number = Math.random,
  remainingMs?: number,
): number {
  const { retryAfter } = err.protocolError;
  const delayMs = retryAfter !== undefined ? retryAfter * 1000 : backoffMs(retryIndex, config.baseDelayMs, random);
  return remainingMs === undefined ? delayMs : Math.min(delayMs, remainingMs);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * A sleep that resolves early, and rejects, when `signal` fires — mirrors
 * nax-ai's retry.ts `abortableSleep` so a pending backoff cannot outlive the
 * caller's own cancellation and go on to start a request nobody wants.
 */
export function abortableSleep(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return sleep(ms);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, reject);
  });
}

/** The real timer. Named and exported so the only production wiring of it is one reference. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TurnRetryDeps<T> {
  /** Re-issues the round trip. Called once per retry, never for the triggering attempt. */
  readonly attempt: () => Promise<T>;
  readonly config: TurnRetryConfig;
  /** Whole-turn wall-clock budget. Absent means unbounded, matching TurnDeps.deadline. */
  readonly deadline?: { expired(): boolean; remainingMs(): number | undefined };
  readonly signal?: AbortSignal;
  /**
   * The sleep used for backoff. Deliberately REQUIRED and without a default:
   * a real timer here is production wiring (turn-loop.ts passes `realSleep`),
   * and leaving it optional let a test omit it and silently wait out a real
   * multi-second backoff. Required makes that a compile error instead.
   */
  readonly sleep: (ms: number) => Promise<void>;
  /** Injectable jitter source, for deterministic tests. Defaults to Math.random. */
  readonly random?: () => number;
  /** Fired once per retry, before the backoff delay, with a 1-based retry number. */
  readonly onRetry?: (retryNumber: number, delayMs: number, fault: RetryableProtocolError) => void;
}

/**
 * Retries `attempt` while the thrown error is a transport/overloaded fault,
 * bounded by `config.maxAttempts`, the deadline and the abort signal.
 *
 * Exhaustion, a non-retryable error, an expired deadline or an aborted
 * signal all rethrow the triggering error EXACTLY as thrown — never wrapped
 * or mutated. `runNativeTurn` records failure usage against the error's own
 * identity in a WeakMap (`readNativeTurnFailureUsage`), and adapter.ts's
 * `isProtocolStreamError` guard depends on the error keeping its own shape;
 * both would silently break if this function rethrew a new object.
 */
export async function retryTransportFault<T>(firstError: unknown, deps: TurnRetryDeps<T>): Promise<T> {
  const { sleep } = deps;
  const random = deps.random ?? Math.random;
  let err = firstError;
  let retryIndex = 0;

  for (;;) {
    if (!isRetryableTransportFault(err)) throw err;
    if (!canAttemptTurnRetry(retryIndex, deps.config)) throw err;
    if (deps.deadline?.expired() === true || deps.signal?.aborted === true) throw err;

    const fault = err;
    const delayMs = turnRetryDelayMs(fault, retryIndex, deps.config, random, deps.deadline?.remainingMs());
    deps.onRetry?.(retryIndex + 1, delayMs, fault);

    try {
      await abortableSleep(delayMs, sleep, deps.signal);
    } catch {
      // The abort during backoff IS the reason to stop; the transport fault
      // that triggered the retry is still the honest cause to surface, not
      // the abort itself.
      throw fault;
    }

    try {
      return await deps.attempt();
    } catch (nextErr) {
      err = nextErr;
      retryIndex += 1;
    }
  }
}
