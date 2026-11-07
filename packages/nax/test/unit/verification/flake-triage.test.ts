/**
 * Tests for src/verification/flake-triage.ts
 *
 * The flake triage classifier that used to live here is gone; the module keeps
 * only the run-scoped quarantine memo the runtime constructs. This is the
 * regression guard for that retained behavior, reached through the
 * `@/verification` barrel.
 */

import { describe, expect, test } from "bun:test";
import { createQuarantineMemo } from "@/verification";

describe("createQuarantineMemo()", () => {
  test("reports a key as absent, then present after add(), and leaves other keys absent", () => {
    const memo = createQuarantineMemo();

    expect(memo.has("a")).toBe(false);

    memo.add("a");

    expect(memo.has("a")).toBe(true);
    expect(memo.has("b")).toBe(false);
  });

  test("returns a fresh memo per call — one run's quarantine never leaks into another", () => {
    const first = createQuarantineMemo();
    first.add("a");

    expect(first.has("a")).toBe(true);
    expect(createQuarantineMemo().has("a")).toBe(false);
  });
});
