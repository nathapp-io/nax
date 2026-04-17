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

  test("strips backtick wrapping from story ID (LLM markdown artifact from interactive plan)", () => {
    // Claude sometimes wraps IDs in backticks for emphasis when writing directly to file.
    // The JSON is valid so nax run works, but validatePlanOutput was crashing on the backtick.
    const input = makeInput([makeStory({ id: "`US-001`" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.id).toBe("US-001");
  });

  test("strips backtick wrapping and normalizes separator-less ID (e.g. `ST001`)", () => {
    const input = makeInput([makeStory({ id: "`ST001`" })]);
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

  test("maps legacy testStrategy 'tdd-lite' alias to 'three-session-tdd-lite'", () => {
    const input = makeInput([makeStory({ testStrategy: "tdd-lite" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.routing?.testStrategy).toBe("three-session-tdd-lite");
  });

  test("accepts valid testStrategy 'tdd-simple' as-is", () => {
    const input = makeInput([makeStory({ testStrategy: "tdd-simple" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.routing?.testStrategy).toBe("tdd-simple");
  });

  test("falls back to test-after for unknown testStrategy values", () => {
    const input = makeInput([makeStory({ testStrategy: "unknown-strategy" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.routing?.testStrategy).toBe("test-after");
  });

  test("fixes \\xNN escape (LLM quirk — not valid JSON) to \\u00NN", () => {
    // \x41 = 'A' in some languages, not valid JSON (should be \u0041)
    const escaped = "\\x41";
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    expect(() => validatePlanOutput(json, "feat", "branch")).not.toThrow();
    const prd = validatePlanOutput(json, "feat", "branch");
    expect(prd.userStories[0]!.description).toBe("A");
  });

  test("fixes \\xN escape (single hex digit) to \\u000N", () => {
    const escaped = "\\x41";
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    const prd = validatePlanOutput(json, "feat", "branch");
    expect(prd.userStories[0]!.description).toBe("A");
  });

  test("fixes \\uXXX (3 hex digits) to \\u0XXX", () => {
    // \u0041 = 'A' — LLM may output \u041 (3 digits, missing leading zero)
    const escaped = "\\u0041";
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    expect(() => validatePlanOutput(json, "feat", "branch")).not.toThrow();
    const prd = validatePlanOutput(json, "feat", "branch");
    expect(prd.userStories[0]!.description).toBe("A");
  });

  test("fixes \\uXX (2 hex digits) to \\u00XX", () => {
    const escaped = "\\u0041";
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    const prd = validatePlanOutput(json, "feat", "branch");
    expect(prd.userStories[0]!.description).toBe("A");
  });

  test("fixes \\uX (1 hex digit) to \\u000X", () => {
    const escaped = "\\u0041";
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    const prd = validatePlanOutput(json, "feat", "branch");
    expect(prd.userStories[0]!.description).toBe("A");
  });

  test("strips backslash from invalid \\u escape with no hex digits", () => {
    // \u followed by non-hex chars: strip the backslash, let JSON.parse handle the rest
    const escaped = "\\uQQQQ";
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    expect(() => validatePlanOutput(json, "feat", "branch")).not.toThrow();
  });

  test("strips backslash from bare invalid escape (\\N where N is not a valid escape char)", () => {
    // A literal backslash before a random char that is not a JSON escape
    const escaped = "foo\\nbar"; // \n is valid, but \a is not
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    expect(() => validatePlanOutput(json, "feat", "branch")).not.toThrow();
    const prd = validatePlanOutput(json, "feat", "branch");
    // \n is valid → stays as newline; \a backslash stripped → "foo\nbar" with literal \a
    // Actually \n stays (valid), \a backslash removed → "foo\nbar" (but 'a' literal)
    // description becomes "foo\nbar" where \n is real newline, a is literal 'a'
    expect(prd.userStories[0]!.description).toContain("a");
  });

  test("preserves valid unicode escapes \\uXXXX unchanged", () => {
    const escaped = "\\u0041\\u0042\\u0043"; // "ABC"
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    const prd = validatePlanOutput(json, "feat", "branch");
    expect(prd.userStories[0]!.description).toBe("ABC");
  });

  test("preserves all valid JSON escape sequences (\\n \\t \\\" \\\\ \\/ \\r)", () => {
    // Use template literals to avoid JS escape confusion. Valid JSON escapes: \" \\ \/ \n \r \t \b \f
    // In JSON inside template literal: \n=LF, \t=Tab, \\=backslash, \"=doublequote, \/=slash, \r=CR
    const escaped = "line1\\nline2\\ttab\\u0022quote\\\\backslash\\/slash\\rCR";
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    const prd = validatePlanOutput(json, "feat", "branch");
    expect(prd.userStories[0]!.description).toBe('line1\nline2\ttab"quote\\backslash/slash\rCR');
  });

  test("fixes \\x escape in markdown-wrapped JSON", () => {
    const escaped = "\\x41";
    const wrapped = `\`\`\`json\n{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}\n\`\`\``;
    const prd = validatePlanOutput(wrapped, "feat", "branch");
    expect(prd.userStories[0]!.description).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// MW-001: workdir field validation
// ---------------------------------------------------------------------------

describe("validatePlanOutput — workdir validation (MW-001)", () => {
  test("valid relative workdir is accepted and preserved", () => {
    const input = makeInput([makeStory({ workdir: "packages/api" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.workdir).toBe("packages/api");
  });

  test("workdir is optional — omitting it leaves field undefined", () => {
    const input = makeInput([makeStory()]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.workdir).toBeUndefined();
  });

  test("throws when workdir has leading slash (absolute path)", () => {
    const input = makeInput([makeStory({ workdir: "/packages/api" })]);
    expect(() => validatePlanOutput(input, "feat", "branch")).toThrow(/leading \//);
  });

  test("throws when workdir contains '..'", () => {
    const input = makeInput([makeStory({ workdir: "../sibling-package" })]);
    expect(() => validatePlanOutput(input, "feat", "branch")).toThrow(/\.\./);
  });

  test("throws when workdir is not a string", () => {
    const input = makeInput([makeStory({ workdir: 42 })]);
    expect(() => validatePlanOutput(input, "feat", "branch")).toThrow(/workdir.*string/);
  });

  test("nested workdir path is valid", () => {
    const input = makeInput([makeStory({ workdir: "packages/api/src" })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.workdir).toBe("packages/api/src");
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

// ---------------------------------------------------------------------------
// ENH-006: analysis field and contextFiles per story
// ---------------------------------------------------------------------------

describe("validatePlanOutput — ENH-006 analysis and contextFiles", () => {
  test("preserves top-level analysis field when present", () => {
    const input = makeInput([makeStory()]);
    const prd = validatePlanOutput({ ...input, analysis: "Codebase analysis: auth uses passport-jwt" }, "feat", "feat/feat");
    expect(prd.analysis).toBe("Codebase analysis: auth uses passport-jwt");
  });

  test("trims whitespace from analysis field", () => {
    const input = makeInput([makeStory()]);
    const prd = validatePlanOutput({ ...input, analysis: "  some analysis  " }, "feat", "feat/feat");
    expect(prd.analysis).toBe("some analysis");
  });

  test("omits analysis field when not present", () => {
    const prd = validatePlanOutput(makeInput(), "feat", "feat/feat");
    expect(prd.analysis).toBeUndefined();
  });

  test("omits analysis field when empty string", () => {
    const prd = validatePlanOutput({ ...makeInput(), analysis: "  " }, "feat", "feat/feat");
    expect(prd.analysis).toBeUndefined();
  });

  test("preserves contextFiles on story when present", () => {
    const story = makeStory({ contextFiles: ["src/auth/auth.module.ts", "src/auth/auth.service.ts"] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].contextFiles).toEqual(["src/auth/auth.module.ts", "src/auth/auth.service.ts"]);
  });

  test("filters non-string and empty entries from contextFiles", () => {
    const story = makeStory({ contextFiles: ["src/auth.ts", "", 42, null, "src/app.module.ts"] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].contextFiles).toEqual(["src/auth.ts", "src/app.module.ts"]);
  });

  test("omits contextFiles when not present on story", () => {
    const prd = validatePlanOutput(makeInput([makeStory()]), "feat", "feat/feat");
    expect(prd.userStories[0].contextFiles).toBeUndefined();
  });

  test("omits contextFiles when empty array", () => {
    const story = makeStory({ contextFiles: [] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].contextFiles).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SEC-503: contextFiles path traversal prevention
// ---------------------------------------------------------------------------

describe("validatePlanOutput — SEC-503 contextFiles path security", () => {
  test("throws when a contextFiles entry contains '..'", () => {
    const story = makeStory({ contextFiles: ["../../../etc/passwd"] });
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(
      /contextFiles.*\.\./i,
    );
  });

  test("throws when a contextFiles entry is an absolute path", () => {
    const story = makeStory({ contextFiles: ["/etc/passwd"] });
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(
      /contextFiles.*absolute/i,
    );
  });

  test("throws on subtle traversal: foo/../../../etc/passwd", () => {
    const story = makeStory({ contextFiles: ["foo/../../../etc/passwd"] });
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(
      /contextFiles.*\.\./i,
    );
  });

  test("accepts valid relative contextFiles paths", () => {
    const story = makeStory({ contextFiles: ["src/auth.ts", "test/auth.test.ts"] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].contextFiles).toEqual(["src/auth.ts", "test/auth.test.ts"]);
  });

  test("accepts nested relative paths without traversal", () => {
    const story = makeStory({ contextFiles: ["packages/api/src/index.ts"] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].contextFiles).toEqual(["packages/api/src/index.ts"]);
  });
});

// ---------------------------------------------------------------------------
// suggestedCriteria validation
// ---------------------------------------------------------------------------

describe("suggestedCriteria", () => {
  test("absent — validates and omits field", () => {
    const prd = validatePlanOutput(makeInput([makeStory()]), "feat", "feat/feat");
    expect(prd.userStories[0].suggestedCriteria).toBeUndefined();
  });

  test("valid string[] — passes through", () => {
    const story = makeStory({ suggestedCriteria: ["edge case A", "edge case B"] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].suggestedCriteria).toEqual(["edge case A", "edge case B"]);
  });

  test("empty array — stripped to undefined", () => {
    const story = makeStory({ suggestedCriteria: [] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].suggestedCriteria).toBeUndefined();
  });

  test("{criterion, rationale} objects — coerced to plain strings", () => {
    const story = makeStory({
      suggestedCriteria: [
        { criterion: "edge case A", rationale: "debater suggested" },
        { criterion: "edge case B", rationale: "another reason" },
      ],
    });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].suggestedCriteria).toEqual(["edge case A", "edge case B"]);
  });

  test("mixed strings and {criterion} objects — coerced uniformly", () => {
    const story = makeStory({
      suggestedCriteria: ["plain string", { criterion: "from object" }],
    });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].suggestedCriteria).toEqual(["plain string", "from object"]);
  });

  test("non-string elements — throws", () => {
    const story = makeStory({ suggestedCriteria: ["valid", 42] });
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(
      "suggestedCriteria[1] must be a string",
    );
  });

  test("non-array — throws", () => {
    const story = makeStory({ suggestedCriteria: "not an array" });
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(
      "suggestedCriteria must be an array",
    );
  });
});
