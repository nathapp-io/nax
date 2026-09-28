/**
 * Is `value` a promise-like — something `await` would suspend on?
 *
 * Two callers need the SAME answer rather than two near-copies: the loop-event
 * dispatcher decides with it whether an `await` is warranted at all (a
 * synchronous answer must not pay a needless microtask yield), and the plugin
 * stager uses it to detect an `async register()` contract violation. A single
 * predicate keeps those from diverging on an exotic function-thenable.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  const type = typeof value;
  return (type === "object" || type === "function") && typeof (value as { then?: unknown }).then === "function";
}
