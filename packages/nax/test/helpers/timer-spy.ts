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

export interface TimerSpyOptions {
  /**
   * Record only the timers whose arming stack contains this substring.
   *
   * The spy is global, so it sees timers armed by anything running during the
   * call — a subprocess helper, another suite's fixture, a callback the code
   * under test did not arm. When the assertion is "the code under test cleared
   * every timer it armed", a foreign timer shows up as a leak nobody can fix.
   * Set `origin` to a path fragment of the arming module (for example
   * `"src/verification/executor"`) to record only its timers. Unset records
   * everything, which is what a leak assertion wants when nothing else runs.
   */
  readonly origin?: string;
}

export interface TimerSpyResult<T> {
  result: T;
  /** Timer ids armed during the call that matched `origin`, if one was given. */
  armed: unknown[];
  /** Timer ids that were cleared (may include ids armed before the call). */
  cleared: Set<unknown>;
  /** Armed timers whose handler ran — a fired timer cannot be a leak. */
  fired: Set<unknown>;
  /** Armed timers that were never cleared and never fired — these hold the event loop open. */
  leaked: unknown[];
}

/**
 * The arming stack, for the `origin` filter.
 *
 * The first line is this helper's own message, not a frame, so it is dropped:
 * an origin that happens to be a substring of it must not match every timer.
 * `\` is normalised to `/` so a Windows stack (backslash paths) matches a
 * POSIX-style path fragment.
 */
function armingStack(): string {
  const stack = new Error("withTimerSpy: arming stack").stack ?? "";
  return stack.replace(/\\/g, "/").split("\n").slice(1).join("\n");
}

export async function withTimerSpy<T>(fn: () => Promise<T>, options?: TimerSpyOptions): Promise<TimerSpyResult<T>> {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  const armed: unknown[] = [];
  const cleared = new Set<unknown>();
  const fired = new Set<unknown>();
  const origin = options?.origin;

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    // A timer armed outside the origin's frames belongs to whoever armed it:
    // arm it for real and hand its id straight back, recording nothing.
    if (origin !== undefined && !armingStack().includes(origin)) {
      return (realSetTimeout as (...a: unknown[]) => unknown)(handler, timeout, ...args);
    }
    // A string handler is a legacy DOM/Node form Bun rejects outright, so there
    // is no firing to observe: pass it through unwrapped rather than wrapping it
    // in something that would fail at fire time.
    if (typeof handler !== "function") {
      const id = (realSetTimeout as (...a: unknown[]) => unknown)(handler, timeout, ...args);
      armed.push(id);
      return id;
    }
    let id: unknown;
    const wrapper = (...callArgs: unknown[]) => {
      // Recorded before the handler runs, so `fired` covers a handler that
      // throws as well as one that returns.
      fired.add(id);
      return handler(...callArgs);
    };
    id = (realSetTimeout as (...a: unknown[]) => unknown)(wrapper, timeout, ...args);
    armed.push(id);
    return id;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((id?: unknown) => {
    if (id !== undefined) cleared.add(id);
    return (realClearTimeout as (...a: unknown[]) => unknown)(id);
  }) as typeof globalThis.clearTimeout;

  try {
    const result = await fn();
    // A timer that already fired cannot hold the event loop open, so it is not a
    // leak: what leaked is what was armed and is neither cleared nor fired.
    return { result, armed, cleared, fired, leaked: armed.filter((id) => !cleared.has(id) && !fired.has(id)) };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}
