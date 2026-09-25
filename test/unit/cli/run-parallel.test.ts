/**
 * US-002 — `nax run` `--parallel` flag parsing.
 *
 * The parse is extracted as a pure function so it is unit-testable — it
 * previously lived inline in bin/nax.ts after the TUI mount, an untested CLI
 * entry point (same rationale as run-mode.ts / BUG-23 and
 * run-max-iterations.ts / US-001).
 */

import { describe, expect, test } from "bun:test";
import { parseParallelFlag } from "@/cli/run-parallel";

const REJECT_MESSAGE = "--parallel must be a positive integer (omit it to run sequentially)";

describe("parseParallelFlag (US-002)", () => {
  test("AC-1: undefined — the flag was not passed — parses to undefined (sequential)", () => {
    expect(parseParallelFlag(undefined)).toEqual({ ok: true, value: undefined });
  });

  test('AC-2: "4" parses to 4', () => {
    expect(parseParallelFlag("4")).toEqual({ ok: true, value: 4 });
  });

  test('AC-3: "1" parses to 1 (sequential, not parallel)', () => {
    expect(parseParallelFlag("1")).toEqual({ ok: true, value: 1 });
  });

  test.each(["0", "-2", "abc"])("AC-4/5/6: rejects %p as not a positive integer", (raw) => {
    expect(parseParallelFlag(raw)).toEqual({ ok: false, message: REJECT_MESSAGE });
  });

  test("rejects an empty string (boundary: not a positive integer)", () => {
    expect(parseParallelFlag("")).toEqual({ ok: false, message: REJECT_MESSAGE });
  });
});
