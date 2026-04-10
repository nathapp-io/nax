/**
 * Diagnose Analysis
 *
 * Extracted from diagnose.ts: failure pattern detection, symptom descriptions,
 * fix suggestions, and recommendation generation.
 */

import type { NaxStatusFile } from "../execution/status-file";
import type { UserStory } from "../prd";
import type { PRD } from "../prd/types";
import type { DiagnosisReport, FailurePattern, StoryDiagnosis } from "./diagnose";

/** Detect failure pattern for a story */
export function detectFailurePattern(story: UserStory, _prd: PRD, status: NaxStatusFile | null): FailurePattern {
  if (
    story.status === "passed" &&
    story.priorErrors?.some((err) => err.toLowerCase().includes("greenfield-no-tests"))
  ) {
    return "AUTO_RECOVERED";
  }

  if (story.status !== "failed" && story.status !== "blocked" && story.status !== "paused") {
    return "UNKNOWN";
  }

  if (
    story.failureCategory === "greenfield-no-tests" ||
    story.priorErrors?.some((err) => err.toLowerCase().includes("greenfield-no-tests"))
  ) {
    return "GREENFIELD_TDD";
  }

  const testFailingCount = story.priorErrors?.filter((err) => err.toLowerCase().includes("tests-failing")).length || 0;
  if (testFailingCount >= 2) return "TEST_MISMATCH";

  if (
    story.priorErrors?.some((err) => err.toLowerCase().includes("precheck-failed")) ||
    (status?.progress.blocked ?? 0) > 0
  ) {
    return "ENVIRONMENTAL";
  }

  if (story.priorErrors?.some((err) => err.toLowerCase().includes("ratelimited"))) return "RATE_LIMITED";
  if (story.failureCategory === "isolation-violation") return "ISOLATION_VIOLATION";
  if (status?.run.status === "stalled") return "STALLED";
  if (story.priorErrors?.some((err) => err.toLowerCase().includes("session-failure"))) return "SESSION_CRASH";
  if (story.attempts > 3) return "MAX_TIERS_EXHAUSTED";

  return "UNKNOWN";
}

/** Get symptom description for a pattern */
export function getPatternSymptom(pattern: FailurePattern): string {
  const symptoms: Record<FailurePattern, string> = {
    GREENFIELD_TDD: "Story attempted in greenfield project with no existing tests",
    TEST_MISMATCH: "Multiple test failures across attempts",
    ENVIRONMENTAL: "Environment prechecks failed or blockers detected",
    RATE_LIMITED: "API rate limit exceeded",
    ISOLATION_VIOLATION: "Story modified files outside its scope",
    MAX_TIERS_EXHAUSTED: "Story attempted at all configured model tiers without success",
    SESSION_CRASH: "Agent session crashed without producing commits",
    STALLED: "All stories blocked or paused -- no forward progress possible",
    LOCK_STALE: "Lock file present but process is dead",
    AUTO_RECOVERED: "Greenfield issue detected but S5 auto-recovery succeeded",
    UNKNOWN: "Unknown failure pattern",
  };
  return symptoms[pattern] ?? "Unknown failure pattern";
}

/** Get fix suggestion for a pattern */
export function getPatternFixSuggestion(pattern: FailurePattern, _story: UserStory): string {
  const fixes: Record<FailurePattern, string> = {
    GREENFIELD_TDD: "Add --greenfield flag or bootstrap with scaffolding tests first",
    TEST_MISMATCH: "Review acceptance criteria; tests may be too strict or story underspecified",
    ENVIRONMENTAL: "Fix precheck issues (deps, env, build) before re-running",
    RATE_LIMITED: "Wait for rate limit to reset or increase tier limits",
    ISOLATION_VIOLATION: "Narrow story scope or adjust expectedFiles to allow cross-file changes",
    MAX_TIERS_EXHAUSTED: "Simplify story or split into smaller sub-stories",
    SESSION_CRASH: "Check agent logs for crash details; may need manual intervention",
    STALLED: "Resolve blocked stories or skip them to unblock dependencies",
    LOCK_STALE: "Run: rm nax.lock",
    AUTO_RECOVERED: "No action needed -- S5 successfully handled greenfield scenario",
    UNKNOWN: "Review logs and prior errors for clues",
  };
  return fixes[pattern] ?? "Review logs and prior errors for clues";
}

/** Generate recommendations based on diagnosis */
export function generateRecommendations(report: DiagnosisReport): string[] {
  const recommendations: string[] = [];

  if (report.lockCheck.lockPresent && report.lockCheck.pidAlive === false) {
    recommendations.push(`Remove stale lock: ${report.lockCheck.fixCommand}`);
  }

  const criticalPatterns = report.failureAnalysis.filter((f) =>
    ["ENVIRONMENTAL", "STALLED", "SESSION_CRASH"].includes(f.pattern),
  );
  if (criticalPatterns.length > 0) {
    recommendations.push(
      `Fix ${criticalPatterns.length} critical blocker(s): ${criticalPatterns.map((f) => f.storyId).join(", ")}`,
    );
  }

  if (report.failureAnalysis.some((f) => f.pattern === "RATE_LIMITED")) {
    recommendations.push("Wait for rate limits to reset before re-running");
  }

  if (report.failureAnalysis.some((f) => f.pattern === "GREENFIELD_TDD")) {
    recommendations.push("Consider adding --greenfield flag or bootstrap tests for greenfield stories");
  }

  if (report.runSummary.storiesFailed > 0 && recommendations.length === 0) {
    recommendations.push(`Re-run with: nax run -f ${report.runSummary.feature}`);
  }

  if (report.runSummary.storiesFailed === 0 && report.runSummary.storiesPending === 0) {
    recommendations.push("All stories passed -- feature is complete!");
  }

  return recommendations;
}

/** Diagnose each story and build story breakdown + failure analysis lists */
export function diagnoseStories(
  prd: PRD,
  status: NaxStatusFile | null,
): { storyBreakdown: StoryDiagnosis[]; failureAnalysis: StoryDiagnosis[] } {
  const storyBreakdown: StoryDiagnosis[] = [];
  const failureAnalysis: StoryDiagnosis[] = [];

  for (const story of prd.userStories) {
    const pattern = detectFailurePattern(story, prd, status);
    const diagnosis: StoryDiagnosis = {
      storyId: story.id,
      title: story.title,
      status: story.status,
      attempts: story.attempts,
      tier: story.routing?.modelTier,
      strategy: story.routing?.testStrategy,
      pattern,
    };

    storyBreakdown.push(diagnosis);

    if (
      story.status === "failed" ||
      story.status === "blocked" ||
      story.status === "paused" ||
      pattern === "AUTO_RECOVERED"
    ) {
      diagnosis.symptom = getPatternSymptom(pattern);
      diagnosis.fixSuggestion = getPatternFixSuggestion(pattern, story);
      failureAnalysis.push(diagnosis);
    }
  }

  return { storyBreakdown, failureAnalysis };
}
