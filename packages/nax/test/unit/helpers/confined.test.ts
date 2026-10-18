/**
 * Tests for the confined-run helpers (nax#2523).
 *
 * The helpers are what every confined-hygiene assertion stands on, so a silent
 * bug here would weaken the whole confined suite without failing anything.
 * `isConfinedTestRun` is exercised through the barrel because that is how the
 * class C suites import it.
 *
 * Placed under test/unit/ rather than beside the helper: `bun run test` only
 * executes test/unit, test/integration and test/ui.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { SANDBOXED_ENV as AGENT_SANDBOXED_ENV } from "@nathapp/nax-agent";
import * as helpers from "@test/helpers";
import {
  _confinedDeps,
  CONFINED_TEST_ENV,
  isConfinedTestRun,
  runConfinedFiles,
  SANDBOX_UNAVAILABLE_EXIT,
  USAGE_EXIT,
  withDepsRestore,
} from "@test/helpers";

const A_TEST_PATH = "./test/unit/execution/pid-registry.test.ts";

describe("isConfinedTestRun", () => {
  const markers = [CONFINED_TEST_ENV, "NAX_SANDBOXED"] as const;
  let previous: (string | undefined)[];

  beforeEach(() => {
    previous = markers.map((marker) => process.env[marker]);
    for (const marker of markers) delete process.env[marker];
  });

  afterEach(() => {
    for (const [index, marker] of markers.entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[marker];
      else process.env[marker] = value;
    }
  });

  test("sandbox AC-1: returns true with only NAX_SANDBOXED=1", () => {
    process.env.NAX_SANDBOXED = "1";

    expect(isConfinedTestRun()).toBe(true);
  });

  test("sandbox AC-3: returns false with only NAX_SANDBOXED=0", () => {
    process.env.NAX_SANDBOXED = "0";

    expect(isConfinedTestRun()).toBe(false);
  });

  test("sandbox AC-4: the public helper constant agrees with nax-agent", () => {
    expect(helpers.SANDBOXED_ENV).toBe("NAX_SANDBOXED");
    expect(helpers.SANDBOXED_ENV).toBe(AGENT_SANDBOXED_ENV);
  });

  test("AC-1: returns true when NAX_TEST_CONFINED is '1'", () => {
    expect(CONFINED_TEST_ENV).toBe("NAX_TEST_CONFINED");
    process.env.NAX_TEST_CONFINED = "1";

    expect(isConfinedTestRun()).toBe(true);
  });

  test("AC-2: returns false when NAX_TEST_CONFINED is unset", () => {
    delete process.env.NAX_TEST_CONFINED;

    expect(isConfinedTestRun()).toBe(false);
  });

  test("returns false for any other value, so an unrelated env var never reads as confined", () => {
    process.env.NAX_TEST_CONFINED = "0";

    expect(isConfinedTestRun()).toBe(false);
  });
});

describe("runConfinedFiles", () => {
  withDepsRestore(_confinedDeps);

  test("AC-16: rejects when spawning bun fails instead of resolving a substituted exit code", async () => {
    _confinedDeps.spawn = () => {
      throw new Error("spawn bun ENOENT: no such file or directory");
    };

    await expect(runConfinedFiles([A_TEST_PATH])).rejects.toThrow("ENOENT");
  });

  test("AC-17: resolves the runner's sandbox-unavailable exit code unchanged", async () => {
    _confinedDeps.spawn = () => ({ exited: Promise.resolve(SANDBOX_UNAVAILABLE_EXIT) });

    expect(await runConfinedFiles([A_TEST_PATH])).toBe(SANDBOX_UNAVAILABLE_EXIT);
  });

  test("AC-18: resolves the runner's test-failure exit code unchanged", async () => {
    _confinedDeps.spawn = () => ({ exited: Promise.resolve(1) });

    expect(await runConfinedFiles([A_TEST_PATH])).toBe(1);
  });

  test("passes the package frame, the per-test timeout and the caller's paths to the runner", async () => {
    const argv: string[][] = [];
    _confinedDeps.spawn = (spawnArgv) => {
      argv.push([...spawnArgv]);
      return { exited: Promise.resolve(USAGE_EXIT) };
    };

    await runConfinedFiles([A_TEST_PATH, "./test/unit/ui/tui-controls.test.ts"]);

    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain("--package=" + resolve(import.meta.dir, "../../.."));
    expect(argv[0]).toContain("--timeout=5000");
    expect(argv[0]?.slice(-2)).toEqual([A_TEST_PATH, "./test/unit/ui/tui-controls.test.ts"]);
  });
});
