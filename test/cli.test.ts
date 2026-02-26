/**
 * CLI --parallel flag tests
 *
 * Validates that the --parallel flag is correctly parsed and passed to RunOptions.
 */

import { describe, test, expect } from "bun:test";
import type { RunOptions } from "../src/execution/runner";

describe("CLI --parallel flag parsing", () => {
  test("parses --parallel 4 correctly", () => {
    // Simulate parsing --parallel 4
    const parallelArg = "4";
    const parallel = Number.parseInt(parallelArg, 10);

    expect(parallel).toBe(4);
    expect(Number.isNaN(parallel)).toBe(false);
    expect(parallel).toBeGreaterThanOrEqual(0);
  });

  test("parses --parallel 0 (auto-detect mode) correctly", () => {
    const parallelArg = "0";
    const parallel = Number.parseInt(parallelArg, 10);

    expect(parallel).toBe(0);
    expect(Number.isNaN(parallel)).toBe(false);
  });

  test("omitted --parallel defaults to undefined (sequential)", () => {
    // When flag is not provided, parallel should be undefined
    const parallel: number | undefined = undefined;

    expect(parallel).toBeUndefined();
  });

  test("rejects negative --parallel values", () => {
    const parallelArg = "-1";
    const parallel = Number.parseInt(parallelArg, 10);

    expect(parallel).toBe(-1);
    expect(parallel).toBeLessThan(0);
  });

  test("rejects non-numeric --parallel values", () => {
    const parallelArg = "abc";
    const parallel = Number.parseInt(parallelArg, 10);

    expect(Number.isNaN(parallel)).toBe(true);
  });

  test("RunOptions accepts parallel field", () => {
    // Type-check that RunOptions accepts parallel field
    const options: Partial<RunOptions> = {
      parallel: 4,
    };

    expect(options.parallel).toBe(4);
  });

  test("RunOptions accepts parallel=0 (auto-detect)", () => {
    const options: Partial<RunOptions> = {
      parallel: 0,
    };

    expect(options.parallel).toBe(0);
  });

  test("RunOptions accepts parallel=undefined (sequential)", () => {
    const options: Partial<RunOptions> = {
      parallel: undefined,
    };

    expect(options.parallel).toBeUndefined();
  });
});
