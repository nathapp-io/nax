/**
 * US-004 — `buildTestBaselineSection`: the bounded upfront baseline section.
 *
 * One of three shapes renders: captured-with-failures (count + files),
 * captured-green, or a `no-baseline` marker with its reason. Every shape
 * carries the "authoritative — do not re-run the full suite" directive, and
 * every shape is bounded by `MAX_BASELINE_SECTION_CHARS`.
 */

import { describe, expect, test } from "bun:test";
import { buildTestBaselineSection, MAX_BASELINE_SECTION_CHARS } from "@/prompts/sections/test-baseline";
import type { BaselineEntry, TestBaseline } from "@/verification";

function captured(entries: BaselineEntry[], baseRef: string | undefined = "abc1234"): TestBaseline {
  return {
    kind: "captured",
    source: "preflight",
    capturedAt: "2026-01-15T00:00:00.000Z",
    ...(baseRef !== undefined ? { baseRef } : {}),
    entries,
  };
}

const NO_BASELINE: TestBaseline = {
  kind: "no-baseline",
  reason: "timeout",
  capturedAt: "2026-01-15T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// AC1 — captured baseline with failures
// ---------------------------------------------------------------------------

describe("buildTestBaselineSection — captured baseline with failures (AC1)", () => {
  test("renders the base ref, the failure count, and each failing file", () => {
    const section = buildTestBaselineSection(
      captured([
        { file: "test/unit/alpha.test.ts", testName: "alpha fails" },
        { file: "test/unit/beta.test.ts", testName: "beta fails" },
      ]),
    );

    expect(section).toContain("`abc1234`");
    expect(section).toContain("2 failing test(s)");
    expect(section).toContain("test/unit/alpha.test.ts");
    expect(section).toContain("test/unit/beta.test.ts");
  });

  test("omits test names — the section lists files, not individual tests", () => {
    const section = buildTestBaselineSection(captured([{ file: "test/unit/alpha.test.ts", testName: "alpha fails" }]));

    expect(section).not.toContain("alpha fails");
  });

  test("lists a file once when several of its tests were failing, keeping the full count", () => {
    const section = buildTestBaselineSection(
      captured([
        { file: "test/unit/alpha.test.ts", testName: "first" },
        { file: "test/unit/alpha.test.ts", testName: "second" },
      ]),
    );

    expect(section).toContain("2 failing test(s)");
    expect(section.split("test/unit/alpha.test.ts")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC2 — captured baseline, zero entries (green)
// ---------------------------------------------------------------------------

describe("buildTestBaselineSection — captured baseline, zero entries (AC2)", () => {
  test("states the baseline is green at the ref and that any full-suite failure is introduced", () => {
    const section = buildTestBaselineSection(captured([]));

    expect(section).toContain("green at `abc1234`");
    expect(section).toContain("introduced by this story");
    expect(section).not.toContain("failing test(s)");
  });
});

// ---------------------------------------------------------------------------
// AC3 — `no-baseline` marker
// ---------------------------------------------------------------------------

describe("buildTestBaselineSection — no-baseline marker (AC3)", () => {
  test("states no baseline is available and includes the marker reason", () => {
    const section = buildTestBaselineSection(NO_BASELINE);

    expect(section).toContain("No baseline available");
    expect(section).toContain("timeout");
  });

  test("renders the reason of each marker variant", () => {
    for (const reason of ["gate-disabled", "no-test-command", "unparseable", "no-gate-parse"] as const) {
      const section = buildTestBaselineSection({ kind: "no-baseline", reason, capturedAt: "" });
      expect(section).toContain(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — the authoritative directive is present in every shape
// ---------------------------------------------------------------------------

describe("buildTestBaselineSection — authoritative directive (AC5)", () => {
  const shapes: [string, TestBaseline][] = [
    ["captured with failures", captured([{ file: "test/unit/alpha.test.ts" }])],
    ["captured green", captured([])],
    ["no-baseline marker", NO_BASELINE],
  ];

  test.each(shapes)("%s carries the authoritative / do-not-re-run directive", (_shape, baseline) => {
    const section = buildTestBaselineSection(baseline);

    expect(section).toContain("authoritative");
    expect(section).toContain("do not re-run the full test suite");
  });
});

// ---------------------------------------------------------------------------
// AC6 — the section is bounded by the character cap
// ---------------------------------------------------------------------------

describe("buildTestBaselineSection — character cap (AC6)", () => {
  const longPaths = Array.from({ length: 200 }, (_, i) => ({
    file: `test/unit/deeply/nested/directory/number-${String(i).padStart(3, "0")}/a-descriptively-named-suite.test.ts`,
  }));

  test("stays within the cap and reports the count, the leading files, and an 'and N more' tail", () => {
    const section = buildTestBaselineSection(captured(longPaths));

    expect(section.length).toBeLessThanOrEqual(MAX_BASELINE_SECTION_CHARS);
    expect(section).toContain("200 failing test(s)");
    expect(section).toContain("number-000");
    expect(section).toMatch(/and \d+ more/);
    // Truncation actually happened: the last file is not rendered.
    expect(section).not.toContain("number-199");
  });

  test("truncated section still carries the authoritative directive", () => {
    const section = buildTestBaselineSection(captured(longPaths));

    expect(section).toContain("authoritative");
    expect(section).toContain("do not re-run the full test suite");
  });

  test("a baseline that fits is rendered in full, with no 'and N more' tail", () => {
    const section = buildTestBaselineSection(
      captured([{ file: "test/unit/alpha.test.ts" }, { file: "test/unit/beta.test.ts" }]),
    );

    expect(section).toContain("test/unit/alpha.test.ts");
    expect(section).toContain("test/unit/beta.test.ts");
    expect(section).not.toMatch(/and \d+ more/);
  });
});

// ---------------------------------------------------------------------------
// Boundary — a captured baseline with no recorded base ref
// ---------------------------------------------------------------------------

describe("buildTestBaselineSection — captured baseline without a base ref", () => {
  test("falls back to prose instead of rendering 'undefined'", () => {
    const section = buildTestBaselineSection(captured([{ file: "test/unit/alpha.test.ts" }], undefined));

    expect(section).not.toContain("undefined");
    expect(section).toContain("1 failing test(s)");
  });

  test("green rendering without a base ref also avoids 'undefined'", () => {
    const section = buildTestBaselineSection(captured([], undefined));

    expect(section).not.toContain("undefined");
    expect(section).toContain("introduced by this story");
  });
});
