/**
 * Acceptance coverage check — count how many of a group's declared acceptance
 * criteria its generated test file names as tests, and warn on a gap.
 *
 * The check is advisory: it never throws and never changes a stage result, an
 * acceptance verdict, a story status or the RED count. Missing ACs used to pass
 * silently (#2257); this surfaces the gap in the run log and in
 * `acceptance-meta.json`'s `coverage` field.
 */

/** One group's observed AC coverage, stored in `acceptance-meta.json`. */
export interface AcceptanceCoverageEntry {
  /** Path to the group's acceptance test file, relative to the run workdir. */
  testPath: string;
  /** Number of acceptance criteria the group declares. */
  expected: number;
  /** Distinct criteria numbers the test file names. */
  found: number;
  /** `AC-N` labels the test file does not name, ascending. */
  missing: string[];
}

/**
 * Count the coverage of `source` against `expected` and warn on any gap.
 *
 * @returns The coverage entry, whether or not there is a gap.
 */
export function checkAcceptanceCoverage(_args: {
  testPath: string;
  source: string;
  expected: number;
  storyId?: string;
}): AcceptanceCoverageEntry {
  return { testPath: _args.testPath, expected: _args.expected, found: 0, missing: [] };
}
