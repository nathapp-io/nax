import { describe, expect, test } from "bun:test";
import {
  buildWorkflowReviewJsonRetry,
  buildWorkflowStoryReviewPrompt,
  buildWorkflowVerdictMismatchRetry,
} from "@/prompts";

const reviewInput = { briefPath: "brief", reportPath: "report", packagePath: "diff", concerns: [] };

describe("running suite prompt", () => {
  test("AC-8: reports the running suite after green gates", () => {
    const prompt = buildWorkflowStoryReviewPrompt({
      ...reviewInput,
      gates: { lint: "green", typecheck: "green", scoped: "green" },
      suiteRunning: true,
    });
    expect(prompt).toContain("scoped tests green, full suite still running.\n");
  });
  test("AC-9: tells the reviewer not to list the running suite", () => {
    expect(buildWorkflowStoryReviewPrompt({ ...reviewInput, suiteRunning: true })).toContain(
      "The full suite is still running while you review; nax records its result itself, so do not list it under cannotVerify.",
    );
  });
  test("AC-10: absent suite is not run", () => {
    expect(buildWorkflowStoryReviewPrompt(reviewInput)).toContain("full suite not run.\n");
  });
});

describe("buildWorkflowVerdictMismatchRetry", () => {
  test("names spec and quality discrepancies and retains the JSON instruction", () => {
    const spec = buildWorkflowVerdictMismatchRetry(["spec"]);
    const quality = buildWorkflowVerdictMismatchRetry(["quality"]);
    expect(spec).toContain(
      "You returned spec: fail but no critical or important spec finding. Either name the acceptance criterion that fails as a finding, or change the verdict to pass.",
    );
    expect(quality).toContain(
      "You returned quality: changes but no critical or important finding. Either name the defect as a finding, or change the verdict to approved.",
    );
    expect(buildWorkflowVerdictMismatchRetry(["spec", "quality"])).toEndWith(buildWorkflowReviewJsonRetry());
  });
});
