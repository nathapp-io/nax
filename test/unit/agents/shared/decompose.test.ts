/**
 * Unit tests for src/agents/shared/decompose.ts (US-002)
 *
 * Verifies:
 * - buildDecomposePrompt accepts targetStory, siblings, and codebaseContext in options
 *   for the plan-mode decompose use case (AC-4)
 * - parseDecomposeOutput handles code-fenced JSON responses (AC-6)
 *
 * Tests for AC-4 FAIL initially — buildDecomposePrompt does not yet accept
 * targetStory/siblings in DecomposeOptions.
 */

import { describe, expect, test } from "bun:test";
import { buildDecomposePrompt, parseDecomposeOutput } from "../../../../src/agents/shared/decompose";
import type { DecomposeOptions } from "../../../../src/agents/shared/types-extended";
import type { UserStory } from "../../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeTargetStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-005",
    title: "Implement rate limiter",
    description: "Add token-bucket rate limiting to the API gateway",
    acceptanceCriteria: [
      "AC-1: Requests exceeding limit receive 429",
      "AC-2: Headers include X-RateLimit-Remaining",
    ],
    tags: ["performance", "security"],
    dependencies: ["US-003"],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: ["src/middleware/rate-limit.ts"],
    routing: {
      complexity: "complex",
      testStrategy: "three-session-tdd",
      reasoning: "Cross-cutting infrastructure concern",
      modelTier: "powerful",
    },
    ...overrides,
  };
}

function makeSiblingStory(id: string, title: string): UserStory {
  return {
    id,
    title,
    description: `Description for ${title}`,
    acceptanceCriteria: ["AC-1: Does something"],
    tags: ["feature"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: ["src/foo.ts"],
    routing: {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "Simple task",
      modelTier: "balanced",
    },
  };
}

const CODEBASE_CONTEXT = `## File Tree

\`\`\`
└── src/
    ├── middleware/
    │   └── rate-limit.ts
    └── index.ts
\`\`\`

## Dependencies

express: ^4.18.0
`;

const BASE_DECOMPOSE_OPTIONS: DecomposeOptions = {
  specContent: "# Feature: Rate Limiting\nAdd token-bucket rate limiting.",
  workdir: "/tmp/test-project",
  codebaseContext: CODEBASE_CONTEXT,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests: AC-4 — buildDecomposePrompt accepts targetStory, siblings, codebaseContext
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDecomposePrompt — plan-mode decompose options (US-002 AC-4)", () => {
  const targetStory = makeTargetStory();

  test("accepts targetStory in options without throwing", () => {
    // Cast to any because the field does not yet exist in DecomposeOptions.
    // After US-002 implementation this cast can be removed.
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings: [],
    } as unknown as DecomposeOptions;

    expect(() => buildDecomposePrompt(options)).not.toThrow();
  });

  test("accepts siblings array in options without throwing", () => {
    const siblings = [
      makeSiblingStory("US-001", "Auth middleware"),
      makeSiblingStory("US-002", "Logging setup"),
    ];
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings,
    } as unknown as DecomposeOptions;

    expect(() => buildDecomposePrompt(options)).not.toThrow();
  });

  test("includes target story title in generated prompt", () => {
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings: [],
    } as unknown as DecomposeOptions;

    const prompt = buildDecomposePrompt(options);
    expect(prompt).toContain(targetStory.title);
  });

  test("includes target story ID in generated prompt", () => {
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings: [],
    } as unknown as DecomposeOptions;

    const prompt = buildDecomposePrompt(options);
    expect(prompt).toContain(targetStory.id);
  });

  test("includes target story acceptance criteria in generated prompt", () => {
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings: [],
    } as unknown as DecomposeOptions;

    const prompt = buildDecomposePrompt(options);
    expect(prompt).toContain("Requests exceeding limit receive 429");
  });

  test("includes sibling story IDs when siblings are provided", () => {
    const siblings = [
      makeSiblingStory("US-006", "Auth setup"),
      makeSiblingStory("US-007", "Logging setup"),
    ];
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings,
    } as unknown as DecomposeOptions;

    const prompt = buildDecomposePrompt(options);
    expect(prompt).toContain("US-006");
    expect(prompt).toContain("US-007");
  });

  test("includes sibling story titles when siblings are provided", () => {
    const siblings = [
      makeSiblingStory("US-006", "Auth setup"),
      makeSiblingStory("US-007", "Logging setup"),
    ];
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings,
    } as unknown as DecomposeOptions;

    const prompt = buildDecomposePrompt(options);
    expect(prompt).toContain("Auth setup");
    expect(prompt).toContain("Logging setup");
  });

  test("includes codebase context in generated prompt", () => {
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings: [],
    } as unknown as DecomposeOptions;

    const prompt = buildDecomposePrompt(options);
    expect(prompt).toContain("rate-limit.ts");
  });

  test("omits sibling section when siblings array is empty", () => {
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings: [],
    } as unknown as DecomposeOptions;

    const prompt = buildDecomposePrompt(options);
    // Sibling section header should not appear for empty list
    expect(prompt).not.toContain("Sibling Stories");
  });

  test("includes sibling section header when at least one sibling is present", () => {
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      targetStory,
      siblings: [makeSiblingStory("US-008", "Other story")],
    } as unknown as DecomposeOptions;

    const prompt = buildDecomposePrompt(options);
    expect(prompt).toContain("Sibling");
  });

  test("does not include specContent as main body when targetStory is provided", () => {
    // When plan-mode decompose is active (targetStory present), the prompt is about
    // splitting that specific story, not the whole spec document.
    const specContent = "UNIQUE_SPEC_CONTENT_MARKER_XYZZY";
    const options = {
      ...BASE_DECOMPOSE_OPTIONS,
      specContent,
      targetStory,
      siblings: [],
    } as unknown as DecomposeOptions;

    const prompt = buildDecomposePrompt(options);
    // The target story's data should take prominence — spec content is not the focus
    expect(prompt).toContain(targetStory.title);
    // (The spec content MAY or MAY NOT appear; we don't mandate either,
    //  but the target story must be present.)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: AC-6 — parseDecomposeOutput handles code-fenced JSON
// These tests PASS already (parseDecomposeOutput already supports code fences).
// They are included to document and protect this behavior as part of the
// plan decompose flow.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDecomposeOutput — code-fenced JSON handling (US-002 AC-6)", () => {
  const VALID_STORY_JSON = JSON.stringify([
    {
      id: "US-001",
      title: "Setup Redis connection",
      description: "Configure Redis client",
      acceptanceCriteria: ["AC-1: Connects to Redis"],
      tags: ["infrastructure"],
      dependencies: [],
      complexity: "medium",
      contextFiles: ["src/redis.ts"],
      reasoning: "Infrastructure setup",
      estimatedLOC: 60,
      risks: [],
      testStrategy: "test-after",
    },
  ]);

  test("parses bare JSON array (no code fences)", () => {
    const result = parseDecomposeOutput(VALID_STORY_JSON);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
  });

  test("parses JSON wrapped in ```json code fence", () => {
    const fenced = `\`\`\`json\n${VALID_STORY_JSON}\n\`\`\``;
    const result = parseDecomposeOutput(fenced);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
    expect(result[0].title).toBe("Setup Redis connection");
  });

  test("parses JSON wrapped in ``` code fence (no language tag)", () => {
    const fenced = `\`\`\`\n${VALID_STORY_JSON}\n\`\`\``;
    const result = parseDecomposeOutput(fenced);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
  });

  test("parses code-fenced JSON with surrounding explanation text", () => {
    const output = `Here are the decomposed stories:\n\n\`\`\`json\n${VALID_STORY_JSON}\n\`\`\`\n\nLet me know if you need adjustments.`;
    const result = parseDecomposeOutput(output);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
  });

  test("throws when code-fenced content is not valid JSON", () => {
    const invalid = "```json\n[{bad json\n```";
    expect(() => parseDecomposeOutput(invalid)).toThrow();
  });

  test("coerces missing fields to defaults (contextFiles defaults to [])", () => {
    const minimalJson = JSON.stringify([{ id: "US-001", title: "Minimal story" }]);
    const fenced = `\`\`\`json\n${minimalJson}\n\`\`\``;
    const result = parseDecomposeOutput(fenced);
    expect(result[0].contextFiles).toEqual([]);
  });

  test("throws when code-fenced JSON is empty array", () => {
    const fenced = "```json\n[]\n```";
    expect(() => parseDecomposeOutput(fenced)).toThrow("empty story array");
  });
});
