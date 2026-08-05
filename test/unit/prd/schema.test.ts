import { describe, expect, test } from "bun:test";
import { MAX_OUT_OF_SCOPE_ITEMS } from "@/prd";
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

  test.each([
    ["```json block", '```json\n{"a":1}\n```', '{"a":1}'],
    ["plain ``` block", '```\n{"b":2}\n```', '{"b":2}'],
  ])("extracts from %s", (_label, text, expected) => {
    expect(extractJsonFromMarkdown(text)).toBe(expected);
  });

  test("trims whitespace inside code block; handles multiline JSON", () => {
    expect(extractJsonFromMarkdown('```json\n  { "c": 3 }  \n```').trim()).toBe('{ "c": 3 }');

    const inner = '{\n  "userStories": []\n}';
    expect(extractJsonFromMarkdown(`\`\`\`json\n${inner}\n\`\`\``)).toBe(inner);
  });
});

// ---------------------------------------------------------------------------
// validatePlanOutput — AC-1: valid input passes
// ---------------------------------------------------------------------------

describe("validatePlanOutput — valid input", () => {
  test("returns a PRD with auto-filled metadata; parses JSON string input", () => {
    const prd = validatePlanOutput(makeInput(), "my-feature", "feat/my-feature");
    expect(prd.feature).toBe("my-feature");
    expect(prd.branchName).toBe("feat/my-feature");
    expect(prd.createdAt).toBeTruthy();
    expect(prd.updatedAt).toBeTruthy();
    expect(prd.userStories).toHaveLength(1);

    expect(validatePlanOutput(JSON.stringify(makeInput()), "feat", "branch").userStories).toHaveLength(1);
  });

  test.each([
    ["status to 'pending'", makeInput([makeStory({ status: "passed" })]), (s: any) => s.status, "pending"],
    ["passes to false", makeInput([makeStory({ passes: true })]), (s: any) => s.passes, false],
    ["attempts to 0", makeInput([makeStory({ attempts: 5 })]), (s: any) => s.attempts, 0],
  ])("forces %s", (_label, input, getField, expected) => {
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(getField(prd.userStories[0]!)).toBe(expected);
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
  test.each([
    ["userStories missing", {}, /userStories/],
    ["userStories empty array", { userStories: [] }, /userStories/],
    ["story id missing", makeInput([makeStory({ id: undefined })]), /id/],
    ["story id empty string", makeInput([makeStory({ id: "" })]), /id/],
    ["story title missing", makeInput([makeStory({ title: undefined })]), /title/],
    ["story title empty string", makeInput([makeStory({ title: "" })]), /title/],
    ["story description missing", makeInput([makeStory({ description: undefined })]), /description/],
    ["story description empty string", makeInput([makeStory({ description: "" })]), /description/],
    ["acceptanceCriteria missing", makeInput([makeStory({ acceptanceCriteria: undefined })]), /acceptanceCriteria/],
    ["acceptanceCriteria empty array", makeInput([makeStory({ acceptanceCriteria: [] })]), /acceptanceCriteria/],
  ])("throws when %s", (_, input, pattern) => {
    expect(() => validatePlanOutput(input, "feat", "branch")).toThrow(pattern);
  });
});

// ---------------------------------------------------------------------------
// AC-3: invalid complexity throws with valid options listed
// ---------------------------------------------------------------------------

describe("validatePlanOutput — complexity validation", () => {
  test.each([
    ["invalid value 'easy'", makeInput([makeStory({ complexity: "easy" })]), /simple|medium|complex|expert/],
    ["missing", makeInput([makeStory({ complexity: undefined })]), /complexity/],
  ])("throws when complexity is %s", (_, input, pattern) => {
    expect(() => validatePlanOutput(input, "feat", "branch")).toThrow(pattern);
  });
});

// ---------------------------------------------------------------------------
// AC-4: dependency references to non-existent story IDs throw
// ---------------------------------------------------------------------------

describe("validatePlanOutput — dependency validation", () => {
  test("throws for non-existent dependency ID; valid cross-story deps pass", () => {
    expect(() => validatePlanOutput(makeInput([makeStory({ id: "ST-001", dependencies: ["ST-999"] })]), "feat", "branch")).toThrow(/ST-999/);
    expect(() => validatePlanOutput(makeInput([makeStory({ id: "ST-001", dependencies: [] }), makeStory({ id: "ST-002", dependencies: ["ST-001"] })]), "feat", "branch")).not.toThrow();
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
  test.each([
    ["```json block", (json: string) => `\`\`\`json\n${json}\n\`\`\``],
    ["plain ``` block", (json: string) => `\`\`\`\n${json}\n\`\`\``],
  ])("parses JSON wrapped in %s", (_label, wrap) => {
    const prd = validatePlanOutput(wrap(JSON.stringify(makeInput())), "feat", "branch");
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

  test.each([
    ["ST001", "ST-001"],
    ["`US-001`", "US-001"],
    ["`ST001`", "ST-001"],
  ])("normalizes story ID %s → %s", (id, expected) => {
    const prd = validatePlanOutput(makeInput([makeStory({ id })]), "feat", "branch");
    expect(prd.userStories[0]!.id).toBe(expected);
  });

  test.each([
    ["Simple", "simple"],
    ["COMPLEX", "complex"],
  ])("normalizes complexity '%s' to '%s'", (input, expected) => {
    const prd = validatePlanOutput(makeInput([makeStory({ complexity: input })]), "feat", "branch");
    expect(prd.userStories[0]!.routing?.complexity).toBe(expected as any);
  });

  test.each([
    ["maps legacy 'tdd-lite' alias", "tdd-lite", "three-session-tdd-lite"],
    ["accepts valid 'tdd-simple' as-is", "tdd-simple", "tdd-simple"],
    ["falls back to test-after for unknown", "unknown-strategy", "test-after"],
  ] as const)("testStrategy: %s", (_label, input, expected) => {
    const prd = validatePlanOutput(makeInput([makeStory({ testStrategy: input })]), "feat", "branch");
    expect(prd.userStories[0]!.routing?.testStrategy).toBe(expected as any);
  });

  test.each([
    ["substantive reasoning is preserved", "Single module with clear interfaces and low risk.", "Single module with clear interfaces and low risk."],
    ["whitespace is trimmed", "  Single module with clear interfaces.  ", "Single module with clear interfaces."],
    ["empty string falls back to placeholder", "", "validated from LLM output"],
    ["missing reasoning falls back to placeholder", undefined, "validated from LLM output"],
  ] as const)("routing.reasoning: %s", (_label, input, expected) => {
    const overrides: Record<string, unknown> = input !== undefined
      ? { routing: { complexity: "simple", testStrategy: "tdd-simple", reasoning: input } }
      : {};
    const prd = validatePlanOutput(makeInput([makeStory(overrides)]), "feat", "branch");
    expect(prd.userStories[0]!.routing?.reasoning).toBe(expected);
  });

  test.each([
    ["\\xNN escape (LLM quirk)", "\\x41", "A"],
    ["\\u0041 (covers \\uXXX/\\uXX/\\uX short-unicode variants)", "\\u0041", "A"],
  ] as const)("fixes %s to correct unicode char", (_label, escaped, expected) => {
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    expect(() => validatePlanOutput(json, "feat", "branch")).not.toThrow();
    expect(validatePlanOutput(json, "feat", "branch").userStories[0]!.description).toBe(expected);
  });

  test("strips backslash from invalid \\u (no hex digits) and bare invalid escape sequences", () => {
    const makeJson = (esc: string) =>
      `{"userStories":[{"id":"ST-001","title":"T","description":"${esc}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    expect(() => validatePlanOutput(makeJson("\\uQQQQ"), "feat", "branch")).not.toThrow();
    const prd = validatePlanOutput(makeJson("foo\\nbar"), "feat", "branch");
    expect(() => validatePlanOutput(makeJson("foo\\nbar"), "feat", "branch")).not.toThrow();
    expect(prd.userStories[0]!.description).toContain("a");
  });

  test.each<[string, string, string]>([
    ["valid \\uXXXX", "\\u0041\\u0042\\u0043", "ABC"],
    ["valid JSON escapes \\n \\t \\\" \\\\ \\/ \\r", "line1\\nline2\\ttab\\u0022quote\\\\backslash\\/slash\\rCR", 'line1\nline2\ttab"quote\\backslash/slash\rCR'],
    ["\\\\( regex — regression for sanitizeInvalidEscapes", "regex /expect\\\\(|foo/", "regex /expect\\(|foo/"],
  ])("preserves %s unchanged in description", (_label, escaped, expected) => {
    const json = `{"userStories":[{"id":"ST-001","title":"T","description":"${escaped}","acceptanceCriteria":["AC-1"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}]}`;
    expect(validatePlanOutput(json, "feat", "branch").userStories[0]!.description).toBe(expected);
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
  test.each([
    ["valid relative path", "packages/api"],
    ["nested relative path", "packages/api/src"],
  ])("accepts %s", (_, workdir) => {
    const input = makeInput([makeStory({ workdir })]);
    const prd = validatePlanOutput(input, "feat", "branch");
    expect(prd.userStories[0]!.workdir).toBe(workdir);
  });

  test.each([
    ["leading slash (absolute path)", "/packages/api", /leading \//],
    ["contains '..'", "../sibling-package", /\.\./],
    ["not a string", 42, /workdir.*string/],
  ])("throws when workdir %s", (_, workdir, pattern) => {
    const input = makeInput([makeStory({ workdir })]);
    expect(() => validatePlanOutput(input, "feat", "branch")).toThrow(pattern);
  });

  test("workdir is optional — omitting it leaves field undefined", () => {
    const prd = validatePlanOutput(makeInput([makeStory()]), "feat", "branch");
    expect(prd.userStories[0]!.workdir).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-8: invalid JSON throws with parse error context
// ---------------------------------------------------------------------------

describe("validatePlanOutput — invalid JSON parse errors (AC-8)", () => {
  test("throws descriptive error with json/parse context for malformed JSON string", () => {
    expect(() => validatePlanOutput("{not valid json}", "feat", "branch")).toThrow();
    let errorMessage = "";
    try {
      validatePlanOutput("{bad: json}", "feat", "branch");
    } catch (err) {
      errorMessage = (err as Error).message;
    }
    expect(errorMessage.toLowerCase()).toMatch(/json|parse/);
  });
});

// ---------------------------------------------------------------------------
// ENH-006: analysis field and contextFiles per story
// ---------------------------------------------------------------------------

describe("validatePlanOutput — ENH-006 analysis and contextFiles", () => {
  test("preserves top-level analysis field and trims whitespace", () => {
    const input = makeInput([makeStory()]);
    const prd = validatePlanOutput({ ...input, analysis: "Codebase analysis: auth uses passport-jwt" }, "feat", "feat/feat");
    expect(prd.analysis).toBe("Codebase analysis: auth uses passport-jwt");
    const prdTrimmed = validatePlanOutput({ ...input, analysis: "  some analysis  " }, "feat", "feat/feat");
    expect(prdTrimmed.analysis).toBe("some analysis");
  });

  test.each([
    ["not present", makeInput()],
    ["empty string", { ...makeInput(), analysis: "  " }],
  ] as const)("omits analysis field when %s", (_label, input) => {
    const prd = validatePlanOutput(input, "feat", "feat/feat");
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

  test.each([
    ["not present on story", makeStory()],
    ["empty array", makeStory({ contextFiles: [] })],
  ])("omits contextFiles when %s", (_label, story) => {
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].contextFiles).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SEC-503: contextFiles path traversal prevention
// ---------------------------------------------------------------------------

describe("validatePlanOutput — SEC-503 contextFiles path security", () => {
  test.each([
    ["contains '..'", "../../../etc/passwd", /contextFiles.*\.\./i],
    ["is an absolute path", "/etc/passwd", /contextFiles.*absolute/i],
    ["subtle traversal", "foo/../../../etc/passwd", /contextFiles.*\.\./i],
  ])("throws when a contextFiles entry %s", (_label, path, pattern) => {
    const story = makeStory({ contextFiles: [path] });
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(pattern);
  });

  test("accepts valid relative contextFiles paths including nested without traversal", () => {
    const story = makeStory({ contextFiles: ["src/auth.ts", "test/auth.test.ts"] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].contextFiles).toEqual(["src/auth.ts", "test/auth.test.ts"]);
    const nested = makeStory({ contextFiles: ["packages/api/src/index.ts"] });
    const prd2 = validatePlanOutput(makeInput([nested]), "feat", "feat/feat");
    expect(prd2.userStories[0].contextFiles).toEqual(["packages/api/src/index.ts"]);
  });
});

// ---------------------------------------------------------------------------
// expectedFiles (files the story creates) — Layer 2
// ---------------------------------------------------------------------------

describe("validatePlanOutput — expectedFiles parsing", () => {
  test("preserves expectedFiles on story when present", () => {
    const story = makeStory({ expectedFiles: ["src/_chat.ts", "src/_tools/web.ts"] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].expectedFiles).toEqual(["src/_chat.ts", "src/_tools/web.ts"]);
  });

  test("filters non-string and empty entries from expectedFiles", () => {
    const story = makeStory({ expectedFiles: ["src/new.ts", "", 42, null, "  src/two.ts  "] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].expectedFiles).toEqual(["src/new.ts", "src/two.ts"]);
  });

  test.each([
    ["not present on story", makeStory()],
    ["empty array", makeStory({ expectedFiles: [] })],
  ])("omits expectedFiles when %s", (_label, story) => {
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].expectedFiles).toBeUndefined();
  });

  test.each([
    ["contains '..'", "../../../etc/passwd", /expectedFiles.*\.\./i],
    ["is an absolute path", "/etc/passwd", /expectedFiles.*absolute/i],
  ])("throws when an expectedFiles entry %s", (_label, path, pattern) => {
    const story = makeStory({ expectedFiles: [path] });
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(pattern);
  });
});

// ---------------------------------------------------------------------------
// modifiedFiles (existing files the story may change) — issue #1450
// ---------------------------------------------------------------------------

describe("validatePlanOutput — modifiedFiles parsing", () => {
  test("survives the round-trip with path and reason intact", () => {
    const story = makeStory({
      modifiedFiles: [{ path: "test/unit/engine/orchestrator.test.ts", reason: "the identity no longer holds" }],
    });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].modifiedFiles).toEqual([
      { path: "test/unit/engine/orchestrator.test.ts", reason: "the identity no longer holds" },
    ]);
  });

  test("keeps an entry whose reason is missing rather than dropping the authorisation", () => {
    const story = makeStory({ modifiedFiles: [{ path: "src/bare.ts" } as never] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].modifiedFiles).toEqual([{ path: "src/bare.ts", reason: "" }]);
  });

  test("filters entries that are not objects or carry no path", () => {
    const story = makeStory({
      modifiedFiles: ["src/str.ts", 42, null, { reason: "no path" }, { path: "  " }, { path: "src/ok.ts" }] as never,
    });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].modifiedFiles).toEqual([{ path: "src/ok.ts", reason: "" }]);
  });

  test.each([
    ["not present on story", makeStory()],
    ["empty array", makeStory({ modifiedFiles: [] })],
  ])("omits modifiedFiles when %s", (_label, story) => {
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].modifiedFiles).toBeUndefined();
  });

  test.each([
    ["contains '..'", "../../../etc/passwd", /modifiedFiles.*\.\./i],
    ["is an absolute path", "/etc/passwd", /modifiedFiles.*absolute/i],
  ])("throws when a modifiedFiles entry %s", (_label, path, pattern) => {
    const story = makeStory({ modifiedFiles: [{ path, reason: "r" }] });
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(pattern);
  });
});

// ---------------------------------------------------------------------------
// suggestedCriteria validation
// ---------------------------------------------------------------------------

describe("suggestedCriteria", () => {
  test.each([
    ["absent", makeStory()],
    ["empty array", makeStory({ suggestedCriteria: [] })],
  ])("omits suggestedCriteria when %s", (_label, story) => {
    expect(validatePlanOutput(makeInput([story]), "feat", "feat/feat").userStories[0].suggestedCriteria).toBeUndefined();
  });

  test("valid string[] — passes through", () => {
    const story = makeStory({ suggestedCriteria: ["edge case A", "edge case B"] });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(prd.userStories[0].suggestedCriteria).toEqual(["edge case A", "edge case B"]);
  });

  test.each([
    ["{criterion, rationale} objects", [{ criterion: "edge case A", rationale: "debater suggested" }, { criterion: "edge case B", rationale: "another reason" }], ["edge case A", "edge case B"]],
    ["mixed strings and objects", ["plain string", { criterion: "from object" }], ["plain string", "from object"]],
  ])("coerces %s to plain strings", (_label, suggestedCriteria, expected) => {
    const prd = validatePlanOutput(makeInput([makeStory({ suggestedCriteria })]), "feat", "feat/feat");
    expect(prd.userStories[0].suggestedCriteria).toEqual(expected);
  });

  test.each([
    ["non-string element", makeStory({ suggestedCriteria: ["valid", 42] }), "suggestedCriteria[1] must be a string"],
    ["non-array", makeStory({ suggestedCriteria: "not an array" }), "suggestedCriteria must be an array"],
  ])("throws for %s", (_label, story, expectedMsg) => {
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(expectedMsg);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 citation fields: verifiedBy, intent, contextFiles[].factId
// ---------------------------------------------------------------------------

describe("validatePlanOutput — Phase 2 citation fields (AC4-AC6)", () => {
  test("AC4+AC5: accepts legacy PRD without citation fields; omits verifiedBy from stories that lack it", () => {
    const prd1 = validatePlanOutput(makeInput([makeStory()]), "feat", "feat/feat");
    const story = prd1.userStories[0]!;
    expect(story.verifiedBy).toBeUndefined();
    expect(story.intent).toBeUndefined();
    expect(story.contextFiles).toBeUndefined();

    const stories = [
      makeStory({ id: "ST-001" }),
      makeStory({ id: "ST-002", verifiedBy: { kind: "file", anchor: "src/x.ts", factIds: [] } }),
    ];
    const prd2 = validatePlanOutput(makeInput(stories), "feat", "feat/feat");
    expect(prd2.userStories[0]!.verifiedBy).toBeUndefined();
    expect(prd2.userStories[1]!.verifiedBy?.kind).toBe("file");
  });

  test.each([
    ["verifiedBy", makeStory({ verifiedBy: { kind: "test", anchor: "src/foo.test.ts#should work", factIds: ["fact-001"] } }), (s: any) => s.verifiedBy, { kind: "test", anchor: "src/foo.test.ts#should work", factIds: ["fact-001"] }],
    ["intent", makeStory({ intent: true }), (s: any) => s.intent, true],
  ])("AC5: preserves %s when present", (_label, story, getField, expected) => {
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    expect(getField(prd.userStories[0]!)).toEqual(expected);
  });

  test("AC5: preserves contextFiles[].factId when present", () => {
    const story = makeStory({
      contextFiles: [
        { path: "src/auth.ts", factId: "fact-001" },
        { path: "src/utils.ts" },
        "src/plain.ts",
      ],
    });
    const prd = validatePlanOutput(makeInput([story]), "feat", "feat/feat");
    const files = prd.userStories[0]!.contextFiles!;
    expect(files).toHaveLength(3);
    expect(files[0]).toEqual({ path: "src/auth.ts", factId: "fact-001" });
    expect(files[1]).toEqual({ path: "src/utils.ts" });
    expect(files[2]).toBe("src/plain.ts");
  });

  test("AC6: rejects invalid verifiedBy.kind with an error", () => {
    const story = makeStory({
      verifiedBy: { kind: "invalid-kind", anchor: "something", factIds: [] },
    });
    expect(() => validatePlanOutput(makeInput([story]), "feat", "feat/feat")).toThrow(/verifiedBy.*kind/i);
  });

});

describe("validatePlanOutput — outOfScope normalization", () => {
  const base = {
    userStories: [
      {
        id: "US-001",
        title: "t",
        description: "d",
        acceptanceCriteria: ["a"],
        routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "j", reasoning: "r" },
      },
    ],
  };

  test("keeps a well-formed feature-level list", () => {
    const prd = validatePlanOutput({ ...base, outOfScope: ["no Ink TUI", "no checkpoints"] }, "f", "b");
    expect(prd.outOfScope).toEqual(["no Ink TUI", "no checkpoints"]);
  });

  test("omits the key entirely for a non-array value", () => {
    expect(validatePlanOutput({ ...base, outOfScope: "a string" }, "f", "b").outOfScope).toBeUndefined();
    expect(validatePlanOutput({ ...base, outOfScope: 42 }, "f", "b").outOfScope).toBeUndefined();
    expect(validatePlanOutput({ ...base, outOfScope: {} }, "f", "b").outOfScope).toBeUndefined();
  });

  test("drops non-string and blank entries instead of failing the plan", () => {
    const prd = validatePlanOutput({ ...base, outOfScope: ["keep", 7, null, "  ", { a: 1 }, "also keep"] }, "f", "b");
    expect(prd.outOfScope).toEqual(["keep", "also keep"]);
  });

  test("omits the key when every entry is dropped", () => {
    expect(validatePlanOutput({ ...base, outOfScope: [1, 2, "  "] }, "f", "b").outOfScope).toBeUndefined();
    expect(validatePlanOutput({ ...base, outOfScope: [] }, "f", "b").outOfScope).toBeUndefined();
  });

  test("deduplicates and caps at MAX_OUT_OF_SCOPE_ITEMS", () => {
    const many = Array.from({ length: MAX_OUT_OF_SCOPE_ITEMS + 10 }, (_, i) => `item ${i}`);
    expect(validatePlanOutput({ ...base, outOfScope: many }, "f", "b").outOfScope).toHaveLength(
      MAX_OUT_OF_SCOPE_ITEMS,
    );
    expect(validatePlanOutput({ ...base, outOfScope: ["dup", "dup", "DUP"] }, "f", "b").outOfScope).toEqual(["dup"]);
  });

  test("normalizes a story-level list the same way", () => {
    const story = { ...base.userStories[0], outOfScope: ["story-specific", 9] };
    const prd = validatePlanOutput({ userStories: [story] }, "f", "b");
    expect(prd.userStories[0].outOfScope).toEqual(["story-specific"]);
  });
});
