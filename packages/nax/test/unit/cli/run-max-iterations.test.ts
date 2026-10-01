/**
 * US-001 — `nax run -m/--max-iterations` flag parsing and config override.
 *
 * The parse and the override are extracted as pure functions so they are
 * unit-testable — they previously lived inline in bin/nax.ts, an untested CLI
 * entry point (same rationale as run-mode.ts / BUG-23).
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { applyMaxIterationsFlag, parseMaxIterationsFlag } from "@/cli/run-max-iterations";

describe("parseMaxIterationsFlag (US-001)", () => {
  test("AC-1: undefined — the flag was not passed — parses to undefined, not a default", () => {
    expect(parseMaxIterationsFlag(undefined)).toEqual({ ok: true, value: undefined });
  });

  test("AC-2: a positive integer string parses to that number", () => {
    expect(parseMaxIterationsFlag("5")).toEqual({ ok: true, value: 5 });
  });

  test.each(["0", "-3", "abc"])("AC-3/4/5: rejects %p as not a positive integer", (raw) => {
    expect(parseMaxIterationsFlag(raw)).toEqual({
      ok: false,
      message: "--max-iterations must be a positive integer",
    });
  });

  test("rejects an empty string (boundary: not a positive integer)", () => {
    expect(parseMaxIterationsFlag("")).toEqual({
      ok: false,
      message: "--max-iterations must be a positive integer",
    });
  });
});

describe("applyMaxIterationsFlag (US-001)", () => {
  test("AC-6: an undefined flag keeps the configured execution.maxIterations", () => {
    const config = makeNaxConfig({ execution: { maxIterations: 3 } });

    expect(applyMaxIterationsFlag(config, undefined).execution.maxIterations).toBe(3);
  });

  test("AC-7: a defined flag replaces the configured execution.maxIterations", () => {
    const config = makeNaxConfig({ execution: { maxIterations: 3 } });

    expect(applyMaxIterationsFlag(config, 5).execution.maxIterations).toBe(5);
  });

  test("AC-8: the input config is never mutated", () => {
    const config = makeNaxConfig({ execution: { maxIterations: 3 } });

    applyMaxIterationsFlag(config, 5);

    expect(config.execution.maxIterations).toBe(3);
  });
});
