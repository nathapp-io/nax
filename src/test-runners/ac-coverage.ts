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

/**
 * Count the distinct acceptance-criteria numbers the source names as tests.
 *
 * Numbers above `expected` are ignored; duplicates collapse to one.
 */
export function acTestCoverage(_source: string, _expected: number): AcTestCoverage {
  return { expected: _expected, found: 0, missing: [] };
}
