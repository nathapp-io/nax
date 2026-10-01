/**
 * Acceptance coverage check — count how many of a group's declared acceptance
 * criteria its generated test file names as tests, and warn on a gap.
 *
 * The check is advisory: it never throws and never changes a stage result, an
 * acceptance verdict, a story status or the RED count. Missing ACs used to pass
 * silently (#2257); this surfaces the gap in the run log and in
 * `acceptance-meta.json`'s `coverage` field.
 */

import path from "node:path";
import { getSafeLogger } from "@/logger";
import { acTestCoverage } from "@/test-runners";

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
export function checkAcceptanceCoverage(args: {
  testPath: string;
  source: string;
  expected: number;
  storyId?: string;
}): AcceptanceCoverageEntry {
  const { testPath, source, expected, storyId } = args;
  const { found, missing } = acTestCoverage(source, expected);

  if (missing.length > 0) {
    getSafeLogger()?.warn("acceptance", "Acceptance test file does not cover every AC", {
      storyId,
      testPath,
      expected,
      found,
      missing,
    });
  }

  return { testPath, expected, found, missing };
}

/**
 * Collect coverage entries for the groups a setup run just generated, warning
 * on each gap. Paths are stored relative to `workdir` so meta stays portable.
 */
export function makeAcceptanceCoverageCollector(workdir: string): {
  record: (testPath: string, source: string, expected: number, storyId?: string) => void;
  entries: () => AcceptanceCoverageEntry[];
} {
  const collected: AcceptanceCoverageEntry[] = [];
  return {
    record(testPath, source, expected, storyId) {
      collected.push(
        checkAcceptanceCoverage({ testPath: path.relative(workdir, testPath), source, expected, storyId }),
      );
    },
    entries() {
      return collected;
    },
  };
}

/**
 * Return the paths of the given groups' test files that are absent from disk.
 * A matching fingerprint proves the inputs were unchanged, not that the files
 * they produced still exist.
 *
 * Paths are returned exactly as supplied (absolute, repo-rooted at the run
 * workdir) so the caller's warning names the concrete file on disk.
 */
export async function findMissingAcceptanceTestPaths(
  groups: ReadonlyArray<{ testPath: string }>,
  fileExists: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const { testPath } of groups) {
    if (!(await fileExists(testPath))) missing.push(testPath);
  }
  return missing;
}

/** Warn that a fingerprint-matching run must regenerate because a file vanished. */
export function warnMissingAcceptanceTests(storyId: string | undefined, missingTestPaths: string[]): void {
  getSafeLogger()?.warn("acceptance-setup", "Acceptance test file missing despite fingerprint match — regenerating", {
    storyId,
    missingTestPaths,
  });
}
