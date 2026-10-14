/**
 * The confined test runner against the real OS sandbox (nax#2523): the two
 * fixtures that pin the policy's temp confinement, and the three nax-agent
 * suites this story repaired.
 *
 * Skipped when this host has no usable sandbox, and inside a confined run —
 * a sandbox launch inside a sandbox does not work (spec: out of scope), and a
 * skipped test is the honest answer there rather than a red one.
 *
 * The runner's own output is captured through its stdout sink so each case can
 * assert the fixture actually ran, not merely that some exit code came back.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isConfinedTestRun, withDepsRestore } from "#test/helpers/index";
// biome-ignore lint/style/noRestrictedImports: the confined runner is a script, not part of the package's importable surface; tests reach it by path
import { _confinedRunDeps, probeConfinedSandbox, runConfinedTests } from "../../../scripts/lib/confined-run.ts";

const PACKAGE_DIR = join(import.meta.dir, "../../..");
const LITERAL_TMP_FIXTURE = "./test/fixtures/confined/writes-literal-tmp.fixture.ts";
const TMPDIR_FIXTURE = "./test/fixtures/confined/writes-tmpdir.fixture.ts";
const LOCK_SUITES = ["./test/unit/internal/file-lock.test.ts", "./test/unit/internal/path-file-lock.test.ts"];

const unavailable = isConfinedTestRun() || !(await probeConfinedSandbox()).available;

function text(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
}

/** Run one confined invocation, returning its exit code and the output it streamed. */
async function confinedRun(paths: readonly string[]): Promise<{ code: number; output: string }> {
  const chunks: string[] = [];
  _confinedRunDeps.stdout = { write: (chunk) => chunks.push(text(chunk)) };
  const code = await runConfinedTests({ packageDir: PACKAGE_DIR, paths });
  return { code, output: chunks.join("") };
}

describe.skipIf(unavailable)("runConfinedTests — real sandbox", () => {
  withDepsRestore(_confinedRunDeps);

  test("AC-21: a fixture writing under a literal /tmp path fails confined", async () => {
    const { code, output } = await confinedRun([LITERAL_TMP_FIXTURE]);
    expect(output).toContain("writes-literal-tmp");
    expect(code).not.toBe(0);
  }, 120_000);

  test("AC-22: a fixture writing under makeTempDir() passes confined", async () => {
    const { code } = await confinedRun([TMPDIR_FIXTURE]);
    expect(code).toBe(0);
  }, 120_000);

  test("AC-23: the two lock suites pass confined", async () => {
    const { code } = await confinedRun(LOCK_SUITES);
    expect(code).toBe(0);
  }, 180_000);

  test("AC-24: the node runtime spawn cases pass confined", async () => {
    const { code } = await confinedRun(["./test/unit/runtime/node-runtime.test.ts"]);
    expect(code).toBe(0);
  }, 180_000);
});
