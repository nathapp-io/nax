/**
 * `isConfinedTestRun()` — whether this process is running inside the confined
 * test runner (`scripts/run-confined-tests.ts`), which exports
 * `NAX_TEST_CONFINED=1` alongside the run's own `TMPDIR`.
 *
 * A test that needs something a confined sandbox withholds (a nested sandbox
 * launch, a setuid probe like `ps`, the shared `/tmp/nax` parent) is skipped
 * with `test.skipIf(isConfinedTestRun())` when its expectation cannot be made
 * environment-independent. Anything else writes under `$TMPDIR` through
 * `makeTempDir()` and passes both ways.
 */
export const CONFINED_TEST_ENV = "NAX_TEST_CONFINED";

/** True only for the exact value the runner exports; any other value reads as a normal run. */
export function isConfinedTestRun(): boolean {
  return process.env[CONFINED_TEST_ENV] === "1";
}
