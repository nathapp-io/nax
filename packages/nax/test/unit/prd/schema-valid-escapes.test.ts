import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { validatePlanOutput } from "@/prd/schema";

const jsonWithDescription = (description: string): string =>
  JSON.stringify({
    userStories: [
      {
        id: "ST-001",
        title: "Escape handling",
        description,
        acceptanceCriteria: ["AC-1: parses description"],
        complexity: "simple",
        testStrategy: "tdd-simple",
        dependencies: [],
      },
    ],
  });

describe("validatePlanOutput JSON escapes", () => {
  test("preserves valid Windows path escapes", () => {
    const description = String.raw`Path C:\users and \xampp`;
    expect(validatePlanOutput(jsonWithDescription(description), "feature", "branch").userStories[0]?.description).toBe(
      description,
    );
  });

  test("preserves valid escaped x and unicode sequences", () => {
    const description = String.raw`\x41 and \u0041`;
    expect(validatePlanOutput(jsonWithDescription(description), "feature", "branch").userStories[0]?.description).toBe(
      description,
    );
  });

  test("repairs an invalid JSON x escape", () => {
    const text = String.raw`{"userStories":[{"id":"ST-001","title":"Escape handling","description":"\x41","acceptanceCriteria":["AC-1: parses description"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    expect(validatePlanOutput(text, "feature", "branch").userStories[0]?.description).toBe("A");
  });

  test("keeps a literal newline inside a string", () => {
    const text = String.raw`{"userStories":[{"id":"ST-001","title":"Escape handling","description":"first
second","acceptanceCriteria":["AC-1: parses description"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    expect(validatePlanOutput(text, "feature", "branch").userStories[0]?.description).toBe("first\nsecond");
  });

  test("throws a schema validation error for text that is not JSON", () => {
    try {
      validatePlanOutput("not JSON", "feature", "branch");
    } catch (error) {
      assertNaxError(error, "invalid PRD JSON");
      expect(error.code).toBe("SCHEMA_VALIDATION_FAILED");
      return;
    }
    throw new Error("expected validation to fail");
  });
});
