import { assertCaughtInstanceOf } from "@nathapp/nax-test-kit/bun/assert-caught";
import { NaxError } from "#src/infra/index";

export { assertCaughtInstanceOf };

/** `assertCaughtInstanceOf(value, NaxError)`; see `@nathapp/nax-test-kit/bun/assert-caught`. */
export function assertNaxError(value: unknown, label = "caught error"): asserts value is NaxError {
  assertCaughtInstanceOf(value, NaxError, label);
}
