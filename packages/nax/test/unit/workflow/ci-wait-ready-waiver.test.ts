/**
 * US-004: the starved-only CI readiness waiver. `ciAllowsReady` still allows readiness for
 * `green` alone; an explicit `waiveStarved` option also allows `starved`, and nothing else.
 * The option is what a human invokes (`--waive-starved <reason>`); no run waives CI on its own.
 */
import { describe, expect, test } from "bun:test";
import { ciAllowsReady } from "@/workflow/ci-wait";

const WAIVED = { waiveStarved: true };
const STILL_BLOCKED = ["failed", "pending", "conflicting", "no-checks", "unavailable"] as const;

describe("ciAllowsReady with a starved-only waiver (US-004)", () => {
  test("AC-1: starved without the waiver does not allow readiness", () => {
    expect(ciAllowsReady("starved")).toBe(false);
  });

  test("AC-2: an explicit waiver allows starved", () => {
    expect(ciAllowsReady("starved", WAIVED)).toBe(true);
  });

  test("AC-3: the waiver leaves green allowed", () => {
    expect(ciAllowsReady("green", WAIVED)).toBe(true);
  });

  test.each([...STILL_BLOCKED])("AC-4: %s stays blocked even with the waiver", (outcome) => {
    expect(ciAllowsReady(outcome, WAIVED)).toBe(false);
  });

  test("AC-7: without the option only green allows readiness", () => {
    expect(ciAllowsReady("green")).toBe(true);
    for (const outcome of STILL_BLOCKED) expect(ciAllowsReady(outcome)).toBe(false);
  });
});
