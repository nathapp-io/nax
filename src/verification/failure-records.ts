import type { FailureRecord } from "../prompts";
import type { TestSummary } from "./types";

const UNMAPPED_FAILURE_OUTPUT_MAX_LINES = 200;
const UNMAPPED_FAILURE_OUTPUT_MAX_CHARS = 8_000;

function truncateUnmappedFailureOutput(output: string): string {
  const tailLines = output.split("\n").slice(-UNMAPPED_FAILURE_OUTPUT_MAX_LINES).join("\n");
  if (tailLines.length <= UNMAPPED_FAILURE_OUTPUT_MAX_CHARS) {
    return tailLines;
  }

  return `... (truncated)\n${tailLines.slice(-UNMAPPED_FAILURE_OUTPUT_MAX_CHARS)}`;
}

export function buildFailureRecords(testSummary: TestSummary, rawOutput?: string): FailureRecord[] {
  if (testSummary.failures.length > 0) {
    return testSummary.failures.map((failure) => ({
      test: failure.testName,
      file: failure.file,
      message: failure.error,
      output: failure.stackTrace.length > 0 ? failure.stackTrace.join("\n") : undefined,
    }));
  }

  if (testSummary.failed === 0) {
    return [];
  }

  return [
    {
      test: `Unmapped test failures (${testSummary.failed} detected)`,
      message:
        "Structured test failure parsing returned no failure records. Diagnose the regression from the raw test output.",
      output: rawOutput?.trim() ? truncateUnmappedFailureOutput(rawOutput.trim()) : undefined,
    },
  ];
}
