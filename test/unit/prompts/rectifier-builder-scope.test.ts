import { describe, expect, test } from "bun:test";
import { RectifierPromptBuilder } from "../../../src/prompts";
import type { ReviewCheckResult } from "../../../src/review/types";
import { makeStory } from "../../helpers";

describe("RectifierPromptBuilder.reviewRectification scope guidance", () => {
  test("allows package-local prerequisite fixes before classifying a failure as sibling spillover", () => {
    const story = makeStory({
      id: "US-001",
      title: "Prefer const over let in greet()",
      acceptanceCriteria: ["bun run typecheck exits with code 0"],
      routing: { testStrategy: "no-test" },
    });
    const failedChecks: ReviewCheckResult[] = [
      {
        check: "typecheck",
        success: false,
        command: "bun run typecheck",
        exitCode: 2,
        output: "error TS2688: Cannot find type definition file for 'bun-types'.",
        durationMs: 1,
      },
    ];

    const prompt = RectifierPromptBuilder.reviewRectification(failedChecks, story);

    expect(prompt).toContain("smallest package-local fix is required");
    expect(prompt).toContain("TEST_EDIT_REASON: sibling_scope");
    expect(prompt).not.toContain("When a lint or typecheck error is in a file you did NOT create or modify in this turn");
  });
});
