import { describe, expect, test } from "bun:test";
import { buildWorkflowReviewJsonRetry, buildWorkflowVerdictMismatchRetry } from "@/prompts";

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
