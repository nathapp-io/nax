/**
 * Runtime assertions that also narrow for TypeScript.
 *
 * The `TS18047`/`TS18048` cluster (#1514 §5.1) is a trap: the natural fix
 * `out!.passed` is matched by *none* of the six escape-hatch counters, so it
 * would retire the typecheck error and leave debt no gate can see. And the
 * obvious test-side alternatives are worse:
 *
 * - `expect(out).not.toBeNull()` does not narrow — the next line still errors.
 * - `expect(out?.passed).toBe(x)` narrows but can go *vacuously true*: if the
 *   value really is null, `out?.passed` is `undefined`, and an expectation of
 *   `undefined` silently passes. That converts a real failure into a green test.
 *
 * These helpers throw. A null value fails the test loudly, with the name of the
 * thing that was missing — strictly more informative than the `TypeError` a `!`
 * would have produced at the same line. They are not escape hatches: nothing is
 * cast, and the check is real at runtime.
 */

/**
 * Narrow `T | null | undefined` to `T`, failing the test if it is absent.
 *
 * ```ts
 * const out = await adversarialReviewOp.verify!(parsed, input, ctx);
 * assertDefined(out, "verify() result");
 * expect(out.passed).toBe(true); // `out` is AdversarialReviewOutput here
 * ```
 *
 * Assertion signatures need the call target to have a declared type, which an
 * imported function declaration has — so importing this from `@test/helpers`
 * narrows exactly as a local declaration would.
 */
export function assertDefined<T>(value: T, label = "value"): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined, got ${value === null ? "null" : "undefined"}`);
  }
}

/**
 * The arguments of a mock's first call, failing the test if it was never called.
 *
 * `mock.calls[0]` is `Args | undefined` under `noUncheckedIndexedAccess`, so
 * destructuring it yields possibly-undefined elements even directly after
 * `expect(m).toHaveBeenCalledTimes(1)` — which does not narrow.
 *
 * ```ts
 * const [taskContext, format, opts] = firstCall(runPlanMock);
 * expect(opts.feature).toBe("debate-plan");
 * ```
 */
export function firstCall<Args extends unknown[]>(m: { mock: { calls: Args[] } }, label = "mock"): Args {
  const call = m.mock.calls[0];
  if (call === undefined) {
    throw new Error(`Expected ${label} to have been called at least once, but it was never called`);
  }
  return call;
}
