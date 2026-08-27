import { NaxError } from "@/errors";

/**
 * Runtime assertion that also narrows for TypeScript, for caught errors.
 *
 * The catch-block blind cast to `NaxError` (as if a caught `unknown` were
 * already typed) asserts nothing at runtime:
 * if the code under test starts throwing a plain `Error` (or any other
 * shape), the cast silences the compiler and the expectation downstream
 * fails with an indirect symptom — `undefined !== "SOME_CODE"` — instead of
 * naming the actual defect. When the file already had an
 * `expect(err).toBeInstanceOf(NaxError)` guard, the cast was still needed
 * because `expect()` does not narrow; the two lines said the same thing and
 * neither made the value readable to the type checker.
 *
 * This helper does the real check once: `instanceof NaxError` is a runtime
 * test (a blind cast is not), it fails loudly with what was actually caught,
 * and the assertion narrows so no cast remains. It follows
 * `assertDefined`'s contract — throws, checks for real at runtime, narrows.
 */

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
  if (value instanceof NaxError) {
    return;
  }
  const described =
    value instanceof Error
      ? `${value.name}("${value.message}")`
      : typeof value === "string"
        ? `"${value}"`
        : String(value);
  throw new Error(`Expected ${label} to be a NaxError, got ${described}`);
}
