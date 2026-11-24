/**
 * `scripts/run-tests.ts` honours the test files it is given (review e684, finding 11).
 *
 * `bun run test test/e2e/fail.test.ts` used to run the unit, integration and ui phases,
 * ignore the file, and report the suite's exit code — a named failing file ran nowhere
 * while `test:e2e` exited 1 on it. Each case below drives the real wrapper by absolute
 * path with its working directory a temporary package holding one passing unit file and
 * one failing e2e file, so what is observed is the runner's own selection.
 *
 * `AGENT` is deleted from the child's environment on purpose: the wrapper pipes and
 * swallows a passing phase's output when `AGENT=1`, and the phase banners are the
 * evidence that a phase ran at all.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { withTempDir } from "@test/helpers";

/** This package's directory: the frame the wrapper is addressed from. */
const PACKAGE_DIR = resolve(import.meta.dir, "../..");

/** The wrapper under test, by absolute path — the spawned process runs in a temp cwd. */
const RUNNER = join(PACKAGE_DIR, "scripts/run-tests.ts");

/** The fixture's failing e2e test, named so the runner's output can be checked for it. */
const FAILING_TEST_NAME = "explicit e2e fixture fails";

/** A spawned `bun test` costs Bun's start-up twice (wrapper + child): 120 s is ample. */
const SPAWN_TIMEOUT_MS = 120_000;

/** The banner `runPhase` prints for each phase it starts. */
const BANNER_PREFIX = "── ";

/**
 * A test file under no phase directory, as a separator-native relative path: the
 * runner reports it resolved, so on Windows the output names `docs\x.test.ts`, and
 * asserting on a literal `docs/x.test.ts` would match nothing there.
 */
const OUTSIDE_PHASE_TEST = join("docs", "x.test.ts");

const UNIT_FIXTURE = `import { expect, test } from "bun:test";

test("explicit unit fixture passes", () => {
  expect(1).toBe(1);
});
`;

const E2E_FIXTURE = `import { expect, test } from "bun:test";

test("${FAILING_TEST_NAME}", () => {
  expect(1).toBe(2);
});
`;

interface RunnerResult {
  readonly exitCode: number;
  /** The wrapper's stdout and stderr, in the order a reader of a terminal would see them. */
  readonly output: string;
}

/**
 * A temporary package with a passing `test/unit/ok.test.ts` and a failing
 * `test/e2e/fail.test.ts`, the two phases that must be told apart.
 */
async function withFixturePackage(fn: (dir: string) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    await Bun.write(join(dir, "test/unit/ok.test.ts"), UNIT_FIXTURE);
    await Bun.write(join(dir, "test/e2e/fail.test.ts"), E2E_FIXTURE);
    await fn(dir);
  });
}

/** The child environment with `AGENT` unset, so passing phases keep their output. */
function runnerEnv(): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AGENT;
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}

/** Run the wrapper in `dir` with `args`, capturing its exit code and output. */
async function runRunner(dir: string, args: readonly string[]): Promise<RunnerResult> {
  const proc = Bun.spawn([process.execPath, RUNNER, ...args], {
    cwd: dir,
    env: runnerEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

/** An explicit failing e2e file, run from the fixture package. */
function runExplicitE2e(dir: string): Promise<RunnerResult> {
  return runRunner(dir, ["test/e2e/fail.test.ts"]);
}

/** A test file under no phase directory, run from the fixture package. */
function runOutsidePhases(dir: string): Promise<RunnerResult> {
  return runRunner(dir, [OUTSIDE_PHASE_TEST]);
}

describe("run-tests — an explicit failing e2e file", () => {
  test(
    "the run exits non-zero and its output names the failing test",
    async () => {
      await withFixturePackage(async (dir) => {
        const { exitCode, output } = await runExplicitE2e(dir);

        expect(exitCode).not.toBe(0);
        expect(output).toContain(FAILING_TEST_NAME);
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "only the e2e phase runs, not the unit phase holding the passing file",
    async () => {
      await withFixturePackage(async (dir) => {
        const { output } = await runExplicitE2e(dir);

        expect(output).toContain(`${BANNER_PREFIX}e2e (`);
        expect(output).not.toContain(`${BANNER_PREFIX}unit (`);
      });
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("run-tests — a file under no phase directory", () => {
  test(
    "the run exits non-zero and its output names the file",
    async () => {
      await withFixturePackage(async (dir) => {
        const { exitCode, output } = await runOutsidePhases(dir);

        expect(exitCode).not.toBe(0);
        expect(output).toContain(OUTSIDE_PHASE_TEST);
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "no phase runs: the selection is refused before the first banner",
    async () => {
      await withFixturePackage(async (dir) => {
        const { output } = await runOutsidePhases(dir);

        expect(output).not.toContain(BANNER_PREFIX);
      });
    },
    SPAWN_TIMEOUT_MS,
  );
});
