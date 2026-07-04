/**
 * Deferred-regression flake-triage helpers.
 *
 * Extracted from run-regression.ts (file-size limit) — resolves the run-scoped
 * baseline diff (changed + mapped test files since the pre-run merge-base) that
 * `triageFlakyFindings` uses for its pre-existing-test check, and runs the
 * triage call + "all quarantined" short-circuit that follows it. The deferred
 * regression gate runs once at end-of-run across all stories, so the diff is
 * repo-root scoped — there is no single story workdir to narrow to.
 */

import type { NaxConfig } from "@/config";
import type { FlakeDetectionConfig } from "@/config/runtime-types";
import type { Finding } from "@/findings";
import { getSafeLogger } from "@/logger";
import { detectFramework, resolveTestFilePatterns } from "@/test-runners";
import type { TestSummary } from "@/test-runners";
import { errorMessage } from "@/utils/errors";
import { getMergeBase } from "@/utils/git";
import type {
  FlakeQuarantineReport,
  FlakeTriageDiff,
  QuarantineMemo,
  triageFlakyFindings,
} from "@/verification/flake-triage";
import { getChangedNonTestFiles, getChangedTestFiles, mapSourceToTests } from "../../verification/smart-runner";
import type { DeferredRegressionResult } from "./run-regression";

/**
 * Resolve the baseline diff for the flake-triage pre-existing-test check.
 * Fails closed on any git/resolver error: an empty diff means every failing
 * test is treated as pre-existing (the safer default — a story-authored test
 * wrongly treated as pre-existing merely skips a quarantine opportunity,
 * while the reverse could quarantine a real regression).
 */
export async function resolveRegressionBaselineDiff(config: NaxConfig, workdir: string): Promise<FlakeTriageDiff> {
  try {
    const resolved = await resolveTestFilePatterns(config, workdir);
    const baseRef = await getMergeBase(workdir);
    const changedTestFiles = await getChangedTestFiles(workdir, workdir, baseRef, undefined, [...resolved.regex]);
    const changedNonTestFiles = await getChangedNonTestFiles(
      workdir,
      baseRef,
      undefined,
      [...resolved.regex],
      undefined,
      workdir,
    );
    const mappedTestFiles = await mapSourceToTests(changedNonTestFiles, workdir, undefined, [...resolved.globs]);
    return { changedTestFiles, mappedTestFiles };
  } catch (err) {
    getSafeLogger()?.warn(
      "regression",
      "Flake triage: baseline diff resolution failed — treating all failures as pre-existing (fail closed)",
      { error: errorMessage(err) },
    );
    return { changedTestFiles: [], mappedTestFiles: [] };
  }
}

/** Discriminated outcome of {@link runRegressionFlakeTriage}. */
export type RegressionTriageOutcome =
  | { shortCircuit: true; result: DeferredRegressionResult }
  | {
      shortCircuit: false;
      triagedFailedFindings: Finding[];
      testFilesInFailures: Set<string>;
      quarantineReport?: FlakeQuarantineReport;
    };

/**
 * Run flaky-test triage on the regression suite's failed-test findings and
 * decide whether every failure was quarantined (AC2 short-circuit — the gate
 * passes with warnings, no attribution, no fix cycles) or whether real
 * failures remain for the attribution pipeline in `runDeferredRegression`.
 *
 * `triageFn` is `_regressionDeps.triageFlakyFindings` from the caller — kept
 * as a parameter (not imported here) so existing tests that stub
 * `_regressionDeps.triageFlakyFindings` continue to intercept the call.
 */
export async function runRegressionFlakeTriage(params: {
  regressionFindings: Finding[];
  testSummary: TestSummary;
  rawOutput: string;
  config: NaxConfig;
  workdir: string;
  testCommand: string;
  quarantineMemo: QuarantineMemo;
  triageFn: (input: Parameters<typeof triageFlakyFindings>[0]) => ReturnType<typeof triageFlakyFindings>;
  flakeDetection: FlakeDetectionConfig;
}): Promise<RegressionTriageOutcome> {
  const {
    regressionFindings,
    testSummary,
    rawOutput,
    config,
    workdir,
    testCommand,
    quarantineMemo,
    triageFn,
    flakeDetection,
  } = params;
  const logger = getSafeLogger();
  const baselineDiff = await resolveRegressionBaselineDiff(config, workdir);
  const triageResult = await triageFn({
    findings: regressionFindings,
    diff: baselineDiff,
    flakeDetection,
    baseCommand: testCommand,
    cwd: workdir,
    framework: detectFramework(rawOutput),
    quarantineMemo,
  });
  const quarantineReport = triageResult.quarantineReport.keys.length > 0 ? triageResult.quarantineReport : undefined;
  const triagedFailedFindings = triageResult.findings.filter((f) => f.category === "failed-test");

  logger?.warn("regression", "Regression detected", {
    failedTests: testSummary.failed,
    passedTests: testSummary.passed,
    quarantined: triageResult.quarantineReport.keys.length,
  });

  const testFilesInFailures = new Set<string>();
  for (const finding of triagedFailedFindings) {
    if (finding.file) testFilesInFailures.add(finding.file);
  }

  if (testFilesInFailures.size === 0 && triagedFailedFindings.length === 0 && quarantineReport) {
    logger?.info("regression", "All regression failures quarantined as flaky — accepting as pass", {
      quarantined: quarantineReport.keys.length,
    });
    return {
      shortCircuit: true,
      result: {
        success: true,
        failedTests: 0,
        failedTestFiles: [],
        passedTests: testSummary.passed,
        rectificationAttempts: 0,
        affectedStories: [],
        storyCosts: {},
        storyDurations: {},
        storyOutcomes: {},
        quarantineReport,
      },
    };
  }

  return { shortCircuit: false, triagedFailedFindings, testFilesInFailures, quarantineReport };
}
