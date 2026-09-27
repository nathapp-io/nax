/**
 * AC coverage counting — how many distinct acceptance-criteria numbers a test
 * source names as tests.
 *
 * The scan is deliberately textual and framework-agnostic: it accepts the four
 * spellings the generator and the polyglot runners actually emit (`AC-N:` test
 * titles, Go `TestACN`, pytest `test_ac_n`, cargo `fn ac_n`). A name inside a
 * comment therefore counts as a hit — accepted, because the result only drives
 * a warning and never a stage result, verdict or story status.
 */

/** Result of {@link acTestCoverage}. */
export interface AcTestCoverage {
  /** The number of acceptance criteria the caller declared. */
  expected: number;
  /** Distinct `N` in `1..expected` that the source names as a test. */
  found: number;
  /** `AC-N` labels in `1..expected` the source does not name, ascending. */
  missing: string[];
}

// `AC-N:` anywhere — test titles in bun/jest/vitest and Go subtests. Case-sensitive:
// the spec marks only the pytest (`test_ac`) and cargo (`fn ac`) forms case-insensitive.
const AC_TITLE_PATTERN = /\bAC-(\d+)\s*:/g;
// Go: `TestAC` + optional separator + number, e.g. `TestAC3`, `TestAC_3`.
const GO_TEST_PATTERN = /\bTestAC[-_]?(\d+)/g;
// pytest: `test_ac` + optional `_` + number, case-insensitive.
const PYTEST_PATTERN = /\btest_ac_?(\d+)/gi;
// cargo: `fn ac` + optional `_` + number, case-insensitive.
const CARGO_PATTERN = /\bfn\s+ac_?(\d+)/gi;

const FRAMEWORK_PATTERNS = [AC_TITLE_PATTERN, GO_TEST_PATTERN, PYTEST_PATTERN, CARGO_PATTERN];

/**
 * Count the distinct acceptance-criteria numbers the source names as tests.
 *
 * Numbers above `expected` are ignored; duplicates collapse to one.
 */
export function acTestCoverage(source: string, expected: number): AcTestCoverage {
  const found = new Set<number>();

  for (const pattern of FRAMEWORK_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const n = Number.parseInt(match[1] ?? "", 10);
      if (Number.isInteger(n) && n >= 1 && n <= expected) {
        found.add(n);
      }
    }
  }

  const missing: string[] = [];
  for (let n = 1; n <= expected; n++) {
    if (!found.has(n)) missing.push(`AC-${n}`);
  }

  return { expected, found: found.size, missing };
}
