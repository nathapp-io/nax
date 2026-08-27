import { NaxError } from "@/errors";

/**
 * Runtime assertions that also narrow for TypeScript, for caught errors.
 *
 * The catch-block blind cast to a class type (as if a caught `unknown` were
 * already typed) asserts nothing at runtime:
 * if the code under test starts throwing a different shape, the cast silences
 * the compiler and the expectation downstream fails with an indirect symptom
 * — `undefined !== "SOME_CODE"` — instead of naming the actual defect. When
 * the file already had an `expect(err).toBeInstanceOf(SomeClass)` guard, the
 * cast was still needed because `expect()` does not narrow; the two lines
 * said the same thing and neither made the value readable to the type
 * checker.
 *
 * These helpers do the real check once: `instanceof` is a runtime test (a
 * blind cast is not), it fails loudly with what was actually caught, and the
 * assertion narrows so no cast remains. They follow `assertDefined`'s
 * contract — throws, checks for real at runtime, narrows.
 */

/**
 * Narrow an unknown caught value to an instance of `Ctor`, failing the test
 * if it is anything else.
 *
 * Works for any error class — `NaxError`, subclasses of it, or classes that
 * extend plain `Error` (`SessionFailureError`, `ParseValidationError`).
 *
 * ```ts
 * } catch (err) {
 *   assertCaughtInstanceOf(err, SessionFailureError, "sendPrompt rejection");
 *   expect(err.adapterFailure.outcome).toBe("fail-stale"); // err is SessionFailureError here
 * }
 * ```
 */
export function assertCaughtInstanceOf<C extends (abstract new (...args: never[]) => unknown) & { name: string }>(
  value: unknown,
  Ctor: C,
  label = "caught error",
): asserts value is InstanceType<C> {
  if (value instanceof Ctor) {
    return;
  }
  const described =
    value instanceof Error
      ? `${value.name}("${value.message}")`
      : typeof value === "string"
        ? `"${value}"`
        : String(value);
  throw new Error(`Expected ${label} to be a ${Ctor.name}, got ${described}`);
}

/**
 * Narrow an unknown caught value to {@link NaxError}, failing the test if it
 * is anything else.
 *
 * ```ts
 * } catch (err) {
 *   assertNaxError(err, "loadConfig rejection");
 *   expect(err.code).toBe("CONFIG_NOT_FOUND"); // `err` is NaxError here
 * }
 * ```
 */
export function assertNaxError(value: unknown, label = "caught error"): asserts value is NaxError {
  assertCaughtInstanceOf(value, NaxError, label);
}
