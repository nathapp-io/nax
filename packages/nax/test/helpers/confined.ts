/**
 * The confined test runner's nax-side helpers (nax#2523).
 *
 * A nax unit suite must pass inside the same OS sandbox a confined agent
 * session gets, and the only honest way to keep it that way is to run it there.
 * `confinedSandboxAvailable()` and `runConfinedFiles()` drive the runner CLI
 * (`packages/nax-agent/scripts/run-confined-tests.ts`) as a process — they do
 * not reimplement its policy — so an integration assertion that a file passes
 * confined exercises the real sandbox, exactly what the CI `test:confined`
 * step does. The runner exports `TMPDIR`/`TMP`/`TEMP` (the run's own temp dir) and
 * `NAX_TEST_CONFINED=1`, so a test writing under a literal `/tmp/...` fails
 * there while `makeTempDir()` — which resolves through `os.tmpdir()`, and so
 * through `$TMPDIR` — passes.
 *
 * `isConfinedTestRun()` tells a test whether it is running under that runner. A
 * test that needs something the sandbox withholds (a nested sandbox launch, a
 * setuid probe like `ps`, the shared `/tmp/nax` parent) skips itself on its
 * answer, so the suite stays honest instead of red where the sandbox is absent.
 */

import { resolve } from "node:path";

/** The marker the runner exports so a test can tell it is running confined. */
export const CONFINED_TEST_ENV = "NAX_TEST_CONFINED";

/** No usable sandbox backend: no test ran, and nax never falls back unsandboxed. */
export const SANDBOX_UNAVAILABLE_EXIT = 3;

/** The runner was called with nothing to run (its own usage exit). */
export const USAGE_EXIT = 2;

/** The per-test timeout `test:confined` runs with — see `scripts/run-tests-phases.ts`. */
export const CONFINED_TEST_TIMEOUT_MS = 5_000;

/** This package's directory: the runner's `--package` frame, and where its paths resolve. */
const PACKAGE_DIR = resolve(import.meta.dir, "../..");

/** The runner CLI, in the sibling package that owns the sandbox code. */
const RUNNER = resolve(import.meta.dir, "../../../nax-agent/scripts/run-confined-tests.ts");

/** What a spawned runner is used for: its exit code. */
export interface ConfinedProc {
  readonly exited: Promise<number>;
}

/**
 * The helper's one external call. The runner's own output is inherited rather
 * than piped: it carries the confined run's failures, which a caller needs
 * exactly when the exit code is non-zero, and inheriting needs no drain that
 * could stall on >64KB of output.
 */
export const _confinedDeps = {
  spawn: (argv: readonly string[], cwd: string): ConfinedProc =>
    Bun.spawn([...argv], { cwd, stdout: "inherit", stderr: "inherit" }),
};

/**
 * Sanctioned copy of `packages/nax-agent/test/helpers/confined.ts` — the
 * runner's own package, where the file lives beside the script that sets the
 * marker.
 *
 * True only when this process is the confined test runner; any other value
 * reads as a normal run.
 */
export function isConfinedTestRun(): boolean {
  return process.env[CONFINED_TEST_ENV] === "1";
}

/** Run the runner CLI with this package's frame and return its exit code unchanged. */
async function runRunner(args: readonly string[]): Promise<number> {
  const proc = _confinedDeps.spawn(
    ["bun", RUNNER, `--package=${PACKAGE_DIR}`, `--timeout=${CONFINED_TEST_TIMEOUT_MS}`, ...args],
    PACKAGE_DIR,
  );
  return await proc.exited;
}

/** Is a confined test run possible on this host? True exactly when the runner's `--probe` exits 0. */
export async function confinedSandboxAvailable(): Promise<boolean> {
  return (await runRunner(["--probe"])) === 0;
}

/**
 * Run `paths` (relative to this package) inside the confined sandbox, returning
 * the runner's exit code unchanged: 0 when they pass, bun test's failure code
 * when they do not, `SANDBOX_UNAVAILABLE_EXIT` with no sandbox, `USAGE_EXIT`
 * when `paths` is empty. A failure to spawn `bun` rejects.
 */
export async function runConfinedFiles(paths: readonly string[]): Promise<number> {
  return await runRunner(paths);
}
