import { describe, expect, test } from "bun:test";
import { extractJsonFromMarkdown, validatePlanOutput } from "../../../src/prd/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ST-001",
    title: "My story",
    description: "Story description",
    acceptanceCriteria: ["AC-1: something works"],
    complexity: "simple",
    testStrategy: "tdd-simple",
    dependencies: [],
    ...overrides,
  };
}

function makeInput(stories: unknown[] = [makeStory()]): Record<string, unknown> {
  return { userStories: stories };
}

// ---------------------------------------------------------------------------
// extractJsonFromMarkdown
// ---------------------------------------------------------------------------

describe("extractJsonFromMarkdown", () => {
  test("returns plain JSON unchanged", () => {
    const json = '{"a":1}';
    expect(extractJsonFromMarkdown(json)).toBe(json);
  });

  test("extracts from ```json ... ``` block", () => {
    const text = '```json\n{"a":1}\n```';
    expect(extractJsonFromMarkdown(text)).toBe('{"a":1}');
  });

  test("extracts from ``` ... ``` block (no language tag)", () => {
    const text = '```\n{"b":2}\n```';
    expect(extractJsonFromMarkdown(text)).toBe('{"b":2}');
  });

  test("trims whitespace inside code block", () => {
    const text = '```json\n  { "c": 3 }  \n```';
    expect(extractJsonFromMarkdown(text).trim()).toBe('{ "c": 3 }');
  });

  test("handles multiline JSON inside code block", () => {
    const inner = '{\n  "userStories": []\n}';
    const text = `\`\`\`json\n${inner}\n\`\`\``;
    expect(extractJsonFromMarkdown(text)).toBe(inner);
  });
});

// ---------------------------------------------------------------------------
// validatePlanOutput — AC-1: valid input passes
// ---------------------------------------------------------------------------

describe("validatePlanOutput — valid input", () => {
  test("returns a PRD with auto-filled metadata", () => {
    const input = makeInput();
    const prd = validatePlanOutput(input, "my-feature", "feat/my-feature");
    expect(prd.feature).toBe("my-feature");
    expect(prd.branchName).toBe("feat/my-feature");
    expect(prd.createdAt).toBeTruthy();
    expect(prd.updatedAt).toBeTruthy();
    expect(prd.userStories).toHaveLength(1);
  });

  test("parses JSON string input", () => {
    const json = JSON.stringify(makeInput());
    const prd = validatePlanOutput(json, "feat", "branch");
    expect(prd.userStories).toHaveLength(1);
  });

  test("forces story status to 'pending'", () => {
    const input = makeInput([makeStory({ status: "passed" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.status).toBe("pending");
  });

  test("forces passes to false", () => {
    const input = makeInput([makeStory({ passes: true })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.passes).toBe(false);
  });

  test("forces attempts to 0", () => {
    const input = makeInput([makeStory({ attempts: 5 })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.attempts).toBe(0);
  });

  test("forces escalations to empty array", () => {
    const input = makeInput([
      makeStory({ escalations: [{ fromTier: "haiku", toTier: "sonnet", reason: "x", timestamp: "t" }] }),
    ]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.escalations).toEqual([]);
  });

  test("validates multiple stories successfully", () => {
    const stories = [
      makeStory({ id: "ST-001", dependencies: [] }),
      makeStory({ id: "ST-002", dependencies: ["ST-001"] }),
    ];
    const prd = validatePlanOutput(makeInput(stories), "feat", "branch");
    expect(prd.userStories).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC-2: missing required fields throw with field name
// ---------------------------------------------------------------------------

describe("validatePlanOutput — missing required fields", () => {
  test("throws when userStories is missing", () => {
    expect(() => validatePlanOutput({}, "feat", "branch")).toThrow(/userStories/);
  });

  test("throws when userStories is empty array", () => {
    expect(() => validatePlanOutput({ userStories: [] }, "feat", "branch")).toThrow(/userStories/);
  });

  test("throws when story id is missing", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ id: undefined })]), "feat", "branch")).toThrow(/id/);
  });

  test("throws when story id is empty string", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ id: "" })]), "feat", "branch")).toThrow(/id/);
  });

  test("throws when story title is missing", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ title: undefined })]), "feat", "branch")).toThrow(/title/);
  });

  test("throws when story title is empty string", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ title: "" })]), "feat", "branch")).toThrow(/title/);
  });

  test("throws when story description is missing", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ description: undefined })]), "feat", "branch")).toThrow(
      /description/,
    );
  });

  test("throws when story description is empty string", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ description: "" })]), "feat", "branch")).toThrow(
      /description/,
    );
  });

  test("throws when acceptanceCriteria is missing", () => {
    expect(() =>
      validatePlanOutput(makeInput([makeStory({ acceptanceCriteria: undefined })]), "feat", "branch"),
    ).toThrow(/acceptanceCriteria/);
  });

  test("throws when acceptanceCriteria is empty array", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ acceptanceCriteria: [] })]), "feat", "branch")).toThrow(
      /acceptanceCriteria/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3: invalid complexity throws with valid options listed
// ---------------------------------------------------------------------------

describe("validatePlanOutput — complexity validation", () => {
  test("throws on invalid complexity with valid options in message", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ complexity: "easy" })]), "feat", "branch")).toThrow(
      /simple|medium|complex|expert/,
    );
  });

  test("throws when complexity is missing", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ complexity: undefined })]), "feat", "branch")).toThrow(
      /complexity/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC-4: dependency references to non-existent story IDs throw
// ---------------------------------------------------------------------------

describe("validatePlanOutput — dependency validation", () => {
  test("throws when dependency references non-existent story ID", () => {
    const stories = [makeStory({ id: "ST-001", dependencies: ["ST-999"] })];
    expect(() => validatePlanOutput(makeInput(stories), "feat", "branch")).toThrow(/ST-999/);
  });

  test("valid cross-story dependencies pass", () => {
    const stories = [
      makeStory({ id: "ST-001", dependencies: [] }),
      makeStory({ id: "ST-002", dependencies: ["ST-001"] }),
    ];
    expect(() => validatePlanOutput(makeInput(stories), "feat", "branch")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-5: status is always forced to 'pending'
// ---------------------------------------------------------------------------

describe("validatePlanOutput — status forced to pending (AC-5)", () => {
  test.each(["passed", "failed", "in-progress", "blocked", "skipped"] as const)(
    "forces status '%s' to pending",
    (status) => {
      const input = makeInput([makeStory({ status })]);
      const prd = validatePlanOutput(input, "feat", "branch");
      expect(prd.userStories[0]!.status).toBe("pending");
    },
  );
});

// ---------------------------------------------------------------------------
// AC-6: JSON wrapped in markdown code blocks is extracted correctly
// ---------------------------------------------------------------------------

describe("validatePlanOutput — markdown extraction (AC-6)", () => {
  test("parses JSON wrapped in ```json block", () => {
    const json = JSON.stringify(makeInput());
    const wrapped = `\`\`\`json\n${json}\n\`\`\``;
    const prd = validatePlanOutput(wrapped, "feat", "branch");
    expect(prd.userStories).toHaveLength(1);
  });

  test("parses JSON wrapped in plain ``` block", () => {
    const json = JSON.stringify(makeInput());
    const wrapped = `\`\`\`\n${json}\n\`\`\``;
    const prd = validatePlanOutput(wrapped, "feat", "branch");
    expect(prd.userStories).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-7: auto-fix common LLM quirks
// ---------------------------------------------------------------------------

describe("validatePlanOutput — auto-fix LLM quirks (AC-7)", () => {
  test("strips trailing commas in JSON string", () => {
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"D","acceptanceCriteria":["AC-1: x"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[],}]}`;
    // Should not throw despite trailing comma
    expect(() => validatePlanOutput(json, "feat", "branch")).not.toThrow();
  });

  test("normalizes story ID from ST001 to ST-001", () => {
    const input = makeInput([makeStory({ id: "ST001" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.id).toBe("ST-001");
  });

  test("normalizes complexity 'Simple' to 'simple'", () => {
    const input = makeInput([makeStory({ complexity: "Simple" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.routing?.complexity).toBe("simple");
  });

  test("normalizes complexity 'COMPLEX' to 'complex'", () => {
    const input = makeInput([makeStory({ complexity: "COMPLEX" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.routing?.complexity).toBe("complex");
  });

  test("maps legacy testStrategy 'tdd-lite' alias to 'tdd-simple'", () => {
    const input = makeInput([makeStory({ testStrategy: "tdd-lite" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.routing?.testStrategy).toBe("tdd-simple");
  });

  test("accepts valid testStrategy 'tdd-simple' as-is", () => {
    const input = makeInput([makeStory({ testStrategy: "tdd-simple" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.routing?.testStrategy).toBe("tdd-simple");
  });

  test("falls back to tdd-simple for unknown testStrategy values", () => {
    const input = makeInput([makeStory({ testStrategy: "unknown-strategy" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.routing?.testStrategy).toBe("tdd-simple");
  });
});

// ---------------------------------------------------------------------------
// AC-8: invalid JSON throws with parse error context
// ---------------------------------------------------------------------------

describe("validatePlanOutput — invalid JSON parse errors (AC-8)", () => {
  test("throws descriptive error for malformed JSON string", () => {
    expect(() => validatePlanOutput("{not valid json}", "feat", "branch")).toThrow();
  });

  test("error message contains context about parse failure", () => {
    let errorMessage = "";
    try {
      validatePlanOutput("{bad: json}", "feat", "branch");
    } catch (err) {
      errorMessage = (err as Error).message;
    }
    // Should contain some indication it's a parse/JSON error
    expect(errorMessage.toLowerCase()).toMatch(/json|parse/);
  });
});
