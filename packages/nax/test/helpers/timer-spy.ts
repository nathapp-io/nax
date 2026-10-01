/**
 * Timer leak detection helper.
 *
 * Wraps a call and records every timer it arms via the global setTimeout, plus
 * every id passed to clearTimeout. An armed-but-never-cleared timer keeps Bun's
 * event loop alive after the call has returned — the failure mode this catches.
 *
 * Spying on the globals (rather than injecting a timer dep) keeps the assertion
 * out of production signatures and works for module-local helpers.
 */
/**
 * DOM-lib `TimerHandler` isn't available with `lib: ["ESNext"]`; every caller
 * passes a plain callback (or a string), so mirror that shape locally.
 */
type TimerHandler = string | ((...args: unknown[]) => void);

export interface TimerSpyResult<T> {
  result: T;
  /** Timer ids armed during the call. */
  armed: unknown[];
  /** Timer ids that were cleared (may include ids armed before the call). */
  cleared: Set<unknown>;
  /** Armed timers that were never cleared — these hold the event loop open. */
  leaked: unknown[];
}

export async function withTimerSpy<T>(fn: () => Promise<T>): Promise<TimerSpyResult<T>> {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  const armed: unknown[] = [];
  const cleared = new Set<unknown>();

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = (realSetTimeout as (...a: unknown[]) => unknown)(handler, timeout, ...args);
    armed.push(id);
    return id;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((id?: unknown) => {
    if (id !== undefined) cleared.add(id);
    return (realClearTimeout as (...a: unknown[]) => unknown)(id);
  }) as typeof globalThis.clearTimeout;

  try {
    const result = await fn();
    return { result, armed, cleared, leaked: armed.filter((id) => !cleared.has(id)) };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}
