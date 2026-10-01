/**
 * Deferred-regression flake-triage helpers.
 *
 * Extracted from run-regression.ts (file-size limit) — runs the triage call
 * (baseline diff via the shared `resolveFlakeBaselineDiff`, see
 * src/verification/flake-baseline-diff.ts) + the "all quarantined"
 * short-circuit that follows it.
 */

import type { NaxConfig } from "@/config";
import type { FlakeDetectionConfig } from "@/config/runtime-types";
import type { Finding } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { TestSummary } from "@/test-runners";
import { detectFramework } from "@/test-runners";
import { logFlakeTriageSkip, type resolveFlakeBaselineDiff } from "@/verification";
import type { FlakeQuarantineReport, QuarantineMemo, triageFlakyFindings } from "@/verification/flake-triage";
import type { DeferredRegressionResult } from "./run-regression";

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
 * `triageFn` and `resolveBaselineDiffFn` are `_regressionDeps.triageFlakyFindings`
 * / `_regressionDeps.resolveFlakeBaselineDiff` from the caller — kept as
 * parameters (not imported here) so existing tests that stub `_regressionDeps`
 * continue to intercept the calls.
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
  resolveBaselineDiffFn: typeof resolveFlakeBaselineDiff;
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
    resolveBaselineDiffFn,
    flakeDetection,
  } = params;
  const logger = getSafeLogger();

  // #1657: this gate is the second `triageFlakyFindings` caller and it has the
  // same skip paths as the per-story seam. Counted under `scope: "regression"`
  // so the §3 decision — which is about the blocking cycle only — can exclude
  // them, while the paths themselves stop reading as zero by construction.
  const untriagedFailures = (): RegressionTriageOutcome => {
    const untriaged = regressionFindings.filter((f) => f.category === "failed-test");
    const testFilesInFailures = new Set<string>();
    for (const finding of untriaged) {
      if (finding.file) testFilesInFailures.add(finding.file);
    }
    return { shortCircuit: false, triagedFailedFindings: untriaged, testFilesInFailures, quarantineReport: undefined };
  };
  const failedTestCount = regressionFindings.filter((f) => f.category === "failed-test").length;

  const framework = detectFramework(rawOutput);
  if (framework === "unknown") {
    // Previously fell through to triage, which probes nothing under an unknown
    // framework (`runFlakeProbe` returns "unprobeable" for every candidate) and
    // quarantines nothing. Bailing here makes that identical outcome visible
    // instead of silent, and matches what `productionTriageSeam` already does.
    logFlakeTriageSkip({
      reason: "framework-undetected",
      candidateCount: failedTestCount,
      candidateBasis: "gate-findings",
      scope: "regression",
    });
    return untriagedFailures();
  }

  const baselineDiff = await resolveBaselineDiffFn(config, workdir);
  if (baselineDiff === null) {
    // Fail closed: skip triage entirely rather than substituting an empty
    // diff, which would make every failing test look pre-existing (see
    // resolveFlakeBaselineDiff's doc comment) — the opposite of fail-closed.
    logFlakeTriageSkip({
      reason: "baseline-diff-unresolved",
      candidateCount: failedTestCount,
      candidateBasis: "gate-findings",
      scope: "regression",
    });
    return untriagedFailures();
  }
  const triageResult = await triageFn({
    findings: regressionFindings,
    diff: baselineDiff,
    flakeDetection,
    baseCommand: testCommand,
    cwd: workdir,
    framework,
    quarantineMemo,
    scope: "regression",
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
