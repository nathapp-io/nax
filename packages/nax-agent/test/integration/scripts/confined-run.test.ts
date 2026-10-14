/**
 * The confined test runner against the real OS sandbox (nax#2523): the two
 * fixtures that pin the policy's temp confinement, and the three nax-agent
 * suites this story repaired.
 *
 * Skipped when this host has no usable sandbox, and inside a confined run —
 * a sandbox launch inside a sandbox does not work (spec: out of scope), and a
 * skipped test is the honest answer there rather than a red one.
 *
 * These cases read the runner's EXIT CODE. Its output cannot carry them:
 * `bun test` prints its version banner to stdout and every per-file line — the
 * header, the source excerpt, `(fail)` — to stderr, which the runner inherits
 * on purpose (`stderr: "inherit"`, into the CI log). A stdout-content assertion
 * here would only ever see the banner.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isConfinedTestRun } from "#test/helpers/index";
import {
  probeConfinedSandbox,
  runConfinedTests,
  SANDBOX_UNAVAILABLE_EXIT,
  // biome-ignore lint/style/noRestrictedImports: the confined runner is a script, not part of the package's importable surface; tests reach it by path
} from "../../../scripts/lib/confined-run.ts";

const PACKAGE_DIR = join(import.meta.dir, "../../..");
const LITERAL_TMP_FIXTURE = "./test/fixtures/confined/writes-literal-tmp.fixture.ts";
const TMPDIR_FIXTURE = "./test/fixtures/confined/writes-tmpdir.fixture.ts";
const LOCK_SUITES = ["./test/unit/internal/file-lock.test.ts", "./test/unit/internal/path-file-lock.test.ts"];

const unavailable = isConfinedTestRun() || !(await probeConfinedSandbox()).available;

function confinedRun(paths: readonly string[]): Promise<number> {
  return runConfinedTests({ packageDir: PACKAGE_DIR, paths });
}

describe.skipIf(unavailable)("runConfinedTests — real sandbox", () => {
  test("AC-21: a fixture writing under a literal /tmp path fails confined", async () => {
    const code = await confinedRun([LITERAL_TMP_FIXTURE]);
    // bun test's own failure exit, not the runner's "no sandbox" code: the
    // suite really ran, and confinement is what failed it.
    expect(code).toBeGreaterThan(0);
    expect(code).not.toBe(SANDBOX_UNAVAILABLE_EXIT);
  }, 120_000);

  test("AC-22: a fixture writing under makeTempDir() passes confined", async () => {
    expect(await confinedRun([TMPDIR_FIXTURE])).toBe(0);
  }, 120_000);

  test("AC-23: the two lock suites pass confined", async () => {
    expect(await confinedRun(LOCK_SUITES)).toBe(0);
  }, 180_000);

  test("AC-24: the node runtime spawn cases pass confined", async () => {
    expect(await confinedRun(["./test/unit/runtime/node-runtime.test.ts"])).toBe(0);
  }, 180_000);
});
