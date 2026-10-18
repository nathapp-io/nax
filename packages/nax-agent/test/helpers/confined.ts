/**
 * `isConfinedTestRun()` — whether this process is running inside the confined
 * test runner (`scripts/run-confined-tests.ts`) or a session sandbox. The runner exports
 * `NAX_TEST_CONFINED=1` alongside the run's own `TMPDIR`.
 *
 * A test that needs something a confined sandbox withholds (a nested sandbox
 * launch, a setuid probe like `ps`, the shared `/tmp/nax` parent) is skipped
 * with `test.skipIf(isConfinedTestRun())` when its expectation cannot be made
 * environment-independent. Anything else writes under `$TMPDIR` through
 * `makeTempDir()` and passes both ways.
 */
import { SANDBOXED_ENV } from "#src/sandbox/index";

export { SANDBOXED_ENV };
export const CONFINED_TEST_ENV = "NAX_TEST_CONFINED";

/** True only when either the runner or session sandbox marker is exactly "1". */
export function isConfinedTestRun(): boolean {
  return process.env[CONFINED_TEST_ENV] === "1" || process.env[SANDBOXED_ENV] === "1";
}
