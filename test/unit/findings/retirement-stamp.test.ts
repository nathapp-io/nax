// test/unit/findings/retirement-stamp.test.ts
//
// US-004 — central predicate for `meta.recurrence.disposition === "retired"`.
//
// The same predicate is consumed by the carry-forward prompt (US-004 AC 1-7)
// and the NBF actionability filter (US-004 AC 8-11). They MUST agree on the
// exact guard, or the prompt will render a finding the fix lane treats as
// actionable (or vice versa). This file pins the guard so a drift on either
// side is caught here before the prompt / NBF tests can diverge.

import { describe, expect, test } from "bun:test";
import { isRecurrenceRetired, readRecurrenceDisposition, retirementIdentity } from "@/findings/retirement-stamp";
import type { Finding } from "@/findings/types";

const advisory = (overrides: Partial<Finding> = {}): Finding => ({
  source: "adversarial-review",
  severity: "warning",
  category: "input",
  message: "m",
  ...overrides,
});

describe("isRecurrenceRetired", () => {
  test("returns true for a finding with meta.recurrence.disposition = retired", () => {
    expect(
      isRecurrenceRetired(
        advisory({ meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } } }),
      ),
    ).toBe(true);
  });

  test("returns false for a non-retired disposition", () => {
    for (const disp of ["blocking", "advisory", "demoted"] as const) {
      expect(isRecurrenceRetired(advisory({ meta: { recurrence: { disposition: disp, rounds: 1 } } }))).toBe(false);
    }
  });

  test("returns false when meta is missing", () => {
    expect(isRecurrenceRetired(advisory())).toBe(false);
  });

  test("returns false when meta.recurrence is missing", () => {
    expect(isRecurrenceRetired(advisory({ meta: { acIndex: 3 } }))).toBe(false);
  });

  test("returns false when meta.recurrence is a string (drift guard)", () => {
    // A future shape change that turns `recurrence` into a bare string must
    // not silently break the predicate — the safe direction is to fall
    // through and treat the finding as not retired, so the prompt still
    // renders it and the fix lane still acts.
    expect(isRecurrenceRetired(advisory({ meta: { recurrence: "retired" as unknown } }))).toBe(false);
  });
});

describe("readRecurrenceDisposition", () => {
  test("returns the disposition when present", () => {
    expect(readRecurrenceDisposition(advisory({ meta: { recurrence: { disposition: "retired", rounds: 1 } } }))).toBe(
      "retired",
    );
  });

  test("returns undefined when the stamp is missing or malformed", () => {
    expect(readRecurrenceDisposition(advisory())).toBeUndefined();
    expect(readRecurrenceDisposition(advisory({ meta: {} }))).toBeUndefined();
    expect(readRecurrenceDisposition(advisory({ meta: { recurrence: "blocking" as unknown } }))).toBeUndefined();
    expect(
      readRecurrenceDisposition(advisory({ meta: { recurrence: { disposition: "unknown" as unknown } } })),
    ).toBeUndefined();
  });
});

describe("retirementIdentity — matches fingerprintFor semantics", () => {
  test("AC-anchored identity uses file + acIndex when present (line excluded)", () => {
    // fingerprintFor's contract is "exclude the line number (shifts as code
    // changes)". A reader that uses `line` would let a same-defect copy
    // reported on a different line escape the suppression.
    const a: Finding = advisory({ file: "lib/x.ts", line: 10, meta: { acIndex: 3 } });
    const b: Finding = advisory({ file: "lib/x.ts", line: 14, meta: { acIndex: 3 } });
    expect(retirementIdentity(a)).toBe(retirementIdentity(b));
  });

  test("AC-anchored identity differs across ACs (no over-merge)", () => {
    const a: Finding = advisory({ file: "lib/x.ts", line: 10, meta: { acIndex: 3 } });
    const b: Finding = advisory({ file: "lib/x.ts", line: 10, meta: { acIndex: 4 } });
    expect(retirementIdentity(a)).not.toBe(retirementIdentity(b));
  });

  test("AC-anchored identity differs across files", () => {
    const a: Finding = advisory({ file: "lib/a.ts", meta: { acIndex: 3 } });
    const b: Finding = advisory({ file: "lib/b.ts", meta: { acIndex: 3 } });
    expect(retirementIdentity(a)).not.toBe(retirementIdentity(b));
  });

  test("prose fingerprint is stable across tail rephrasing (leading-clause prefix)", () => {
    const leading = "window expiry is non-atomic because findFirst runs before upsert";
    const a: Finding = advisory({ file: "lib/store.ts", category: "assumption", message: leading });
    const b: Finding = advisory({
      file: "lib/store.ts",
      category: "assumption",
      message: `${leading} — and one more clause`,
    });
    expect(retirementIdentity(a)).toBe(retirementIdentity(b));
  });

  test("prose fingerprint normalises backslash paths and ./ prefixes", () => {
    const a: Finding = advisory({ file: "lib/store.ts", category: "x", message: "text" });
    const b: Finding = advisory({ file: "lib\\store.ts", category: "x", message: "text" });
    const c: Finding = advisory({ file: "./lib/store.ts", category: "x", message: "text" });
    expect(retirementIdentity(b)).toBe(retirementIdentity(a));
    expect(retirementIdentity(c)).toBe(retirementIdentity(a));
  });

  test("prose fingerprint differs across categories", () => {
    const a: Finding = advisory({ file: "lib/x.ts", category: "input", message: "text padded padded padded" });
    const b: Finding = advisory({ file: "lib/x.ts", category: "assumption", message: "text padded padded padded" });
    expect(retirementIdentity(a)).not.toBe(retirementIdentity(b));
  });

  test("prose fingerprint differs across files", () => {
    const a: Finding = advisory({ file: "lib/a.ts", category: "x", message: "text" });
    const b: Finding = advisory({ file: "lib/b.ts", category: "x", message: "text" });
    expect(retirementIdentity(a)).not.toBe(retirementIdentity(b));
  });

  test("AC-anchored identity wins over prose when both are present", () => {
    // When meta.acIndex is present it is the canonical identity — a prose
    // match must not override it. Two findings with the same acIndex but
    // different prose / categories still key on acIndex.
    const a: Finding = advisory({ file: "lib/x.ts", category: "input", message: "alpha", meta: { acIndex: 3 } });
    const b: Finding = advisory({ file: "lib/x.ts", category: "assumption", message: "beta", meta: { acIndex: 3 } });
    expect(retirementIdentity(a)).toBe(retirementIdentity(b));
  });
});
