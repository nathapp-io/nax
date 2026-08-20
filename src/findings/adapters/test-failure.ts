import type { TestFailure, TestSummary } from "@/test-runners";
import type { Finding } from "../types";

export function testFailureToFinding(failure: TestFailure): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: failure.testName,
    file: failure.file,
    message: failure.error,
  };
}

export function testSummaryToFindings(summary: TestSummary): Finding[] {
  return summary.failures.map(testFailureToFinding);
}
