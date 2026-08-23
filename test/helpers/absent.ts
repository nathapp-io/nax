/**
 * Deliberately-absent values for negative tests: feeding `undefined`/`null` to a
 * parameter whose type forbids it, because the absence *is* the assertion.
 *
 * The single type-lie in this file replaces 18 deliberate-absence casts
 * (undefined/null fed to a type that forbids them) across test/. Call sites
 * are counted by the `absentValue` counter in
 * `scripts/check-test-escape-hatches.ts` — this is a ratcheted escape hatch,
 * not a free one. Do not export `coerce`.
 */
function coerce<T>(value: unknown): T {
  return value as T;
}

/** `undefined`, typed as `T`. For "what happens when this required arg is missing?" */
export function absentValue<T>(): T {
  return coerce<T>(undefined);
}

/** `null`, typed as `T`. For "what happens when this required arg is null?" */
export function nullValue<T>(): T {
  return coerce<T>(null);
}
