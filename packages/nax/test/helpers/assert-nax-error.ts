import { assertCaughtInstanceOf } from "@nathapp/nax-test-kit/bun/assert-caught";
import { NaxError } from "@/errors";

/** `assertCaughtInstanceOf` moved to `@nathapp/nax-test-kit/bun/assert-caught` (S2-1); re-exported for nax tests. */
export { assertCaughtInstanceOf };

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
