/**
 * US-002: acTestCoverage — count the distinct acceptance-criteria numbers a
 * test source names as tests.
 *
 * The scan is textual and accepts the four spellings the generator and the
 * polyglot runners emit:
 *   - `AC-N:` anywhere (bun / jest / vitest / Go subtests)
 *   - Go: `TestAC` + optional `_`/`-` + `N`
 *   - pytest: `test_ac` + optional `_` + `N` (case-insensitive)
 *   - cargo: `fn ac` + optional `_` + `N` (case-insensitive)
 */

import { describe, expect, test } from "bun:test";
import { acTestCoverage } from "@/test-runners";

// ---------------------------------------------------------------------------
// AC1–AC3: `AC-N:` test titles
// ---------------------------------------------------------------------------

describe("US-002 acTestCoverage: AC-N: test titles", () => {
  test("AC1: names all three expected criteria → found 3 with no gaps", () => {
    const source = ['test("AC-1: a", () => {})', 'test("AC-2: b", () => {})', 'test("AC-3: c", () => {})'].join("\n");

    expect(acTestCoverage(source, 3)).toEqual({ expected: 3, found: 3, missing: [] });
  });

  test("AC2: one unnamed expected criterion is reported in missing", () => {
    const source = ['test("AC-1: a", () => {})', 'test("AC-3: c", () => {})'].join("\n");

    const result = acTestCoverage(source, 3);

    expect(result.found).toBe(2);
    expect(result.missing).toEqual(["AC-2"]);
  });

  test("AC3: two tests for the same criterion count once", () => {
    const source = ['test("AC-2: x", () => {})', 'test("AC-2: y", () => {})', 'test("AC-1: a", () => {})'].join("\n");

    const result = acTestCoverage(source, 2);

    expect(result.found).toBe(2);
    expect(result.missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC4–AC6: per-framework naming forms
// ---------------------------------------------------------------------------

describe("US-002 acTestCoverage: framework naming forms", () => {
  test("AC4: Go TestACN / TestAC_N subtests are counted", () => {
    const source = [
      "func TestAC1_Parses(t *testing.T) {",
      "\tt.Parallel()",
      "}",
      "",
      "func TestAC_2Rejects(t *testing.T) {",
      "\tt.Parallel()",
      "}",
    ].join("\n");

    const result = acTestCoverage(source, 2);

    expect(result.found).toBe(2);
    expect(result.missing).toEqual([]);
  });

  test("AC5: pytest test_ac_n / test_ACn functions are counted", () => {
    const source = [
      "def test_ac_1_parses():",
      "    assert True",
      "",
      "def test_AC2_rejects():",
      "    assert True",
    ].join("\n");

    const result = acTestCoverage(source, 2);

    expect(result.found).toBe(2);
    expect(result.missing).toEqual([]);
  });

  test("AC6: cargo fn ac_n / fn acn functions are counted", () => {
    const source = ["#[test]", "fn ac_1_parses() {", "}", "", "#[test]", "fn ac2_rejects() {", "}"].join("\n");

    const result = acTestCoverage(source, 2);

    expect(result.found).toBe(2);
    expect(result.missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC7 + boundaries
// ---------------------------------------------------------------------------

describe("US-002 acTestCoverage: bounds", () => {
  test("AC7: numbers above expected are ignored and the gap is listed ascending", () => {
    const source = ['test("AC-1: a", () => {})', 'test("AC-5: e", () => {})'].join("\n");

    const result = acTestCoverage(source, 3);

    expect(result.found).toBe(1);
    expect(result.missing).toEqual(["AC-2", "AC-3"]);
  });

  test("boundary: an empty source reports every expected criterion as missing", () => {
    const result = acTestCoverage("", 3);

    expect(result.found).toBe(0);
    expect(result.missing).toEqual(["AC-1", "AC-2", "AC-3"]);
  });

  test("boundary: expected 0 yields no found and no missing entries", () => {
    const result = acTestCoverage('test("AC-1: a", () => {})', 0);

    expect(result).toEqual({ expected: 0, found: 0, missing: [] });
  });

  test("boundary: an AC number above expected counts for nothing", () => {
    const result = acTestCoverage('test("AC-4: d", () => {})', 2);

    expect(result.found).toBe(0);
    expect(result.missing).toEqual(["AC-1", "AC-2"]);
  });

  test("boundary: the `AC-N:` title form is case-sensitive — lowercase ac-1: does not count", () => {
    const result = acTestCoverage('test("ac-1: a", () => {})', 1);

    expect(result.found).toBe(0);
    expect(result.missing).toEqual(["AC-1"]);
  });
});
