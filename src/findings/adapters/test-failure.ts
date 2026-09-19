import type { TestFailure, TestSummary } from "@/test-runners";
import type { Finding } from "../types";

/**
 * How many stack frames to fold into the message.
 *
 * `Finding` is the ADR-021 wire format shared by lint, typecheck and review;
 * it carries no stack field and gaining one is a wider change than this seam
 * needs. Two frames is enough to name the assertion and its caller without
 * turning a 46-failure list into a wall of frames.
 *
 * The parser collects up to `MAX_STACK_LINES` (5) per failure in
 * `src/test-runners/parse-bun.ts`; the adapter folds only the first
 * `MAX_FRAMES_IN_MESSAGE` (2) of those into the prompt. The two caps differ
 * on purpose — full collection lives in the parser (for any future consumer),
 * the prompt carries just enough location to be actionable.
 */
const MAX_FRAMES_IN_MESSAGE = 2;

export function testFailureToFinding(failure: TestFailure): Finding {
  const frames = failure.stackTrace.slice(0, MAX_FRAMES_IN_MESSAGE);
  const message = frames.length > 0 ? `${failure.error}\n${frames.join("\n")}` : failure.error;

  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: failure.testName,
    file: failure.file,
    message,
  };
}

export function testSummaryToFindings(summary: TestSummary): Finding[] {
  return summary.failures.map(testFailureToFinding);
}
