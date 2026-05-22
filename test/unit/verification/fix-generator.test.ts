// RE-ARCH: keep
/**
 * Fix Generator Tests
 */

import { describe, expect, test } from "bun:test";
import {
  convertFixStoryToUserStory,
  findRelatedStories,
  groupACsByRelatedStories,
  parseACTextFromSpec,
} from "../../../src/acceptance/fix-generator";
import { AcceptancePromptBuilder } from "../../../src/prompts";

function buildFixPrompt(
  batchedACs: string[],
  acTextMap: Record<string, string>,
  testOutput: string,
  relatedStories: string[],
  prd: PRD,
  testFilePath?: string,
): string {
  return new AcceptancePromptBuilder().buildFixGeneratorPrompt({
    batchedACs,
    acTextMap,
    testOutput,
    relatedStories,
    prd,
    testFilePath,
  });
}
import type { PRD, UserStory } from "../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test",
    feature: "test",
    branchName: "test",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    userStories: stories,
  };
}

function makeStory(id: string, acs: string[], status: UserStory["status"] = "passed", workdir?: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description of ${id}`,
    acceptanceCriteria: acs,
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 0,
    workdir,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseACTextFromSpec
// ─────────────────────────────────────────────────────────────────────────────

describe("parseACTextFromSpec", () => {
  test("extracts AC text from spec markdown", () => {
    const spec = `# Feature

## Acceptance Criteria
- AC-1: handles empty input
- AC-2: set(key, value, ttl) expires after ttl milliseconds
- AC-3: validates format`;

    const map = parseACTextFromSpec(spec);

    expect(map).toEqual({
      "AC-1": "handles empty input",
      "AC-2": "set(key, value, ttl) expires after ttl milliseconds",
      "AC-3": "validates format",
    });
  });

  test("handles checkboxes and whitespace", () => {
    const spec = `
- [ ] AC-1: first criterion
  - [x] AC-2: second criterion
AC-3: third criterion
    `;

    const map = parseACTextFromSpec(spec);

    expect(map).toEqual({
      "AC-1": "first criterion",
      "AC-2": "second criterion",
      "AC-3": "third criterion",
    });
  });

  test("normalizes AC IDs to uppercase; returns empty map when no ACs found", () => {
    expect(parseACTextFromSpec("- ac-1: lowercase\n- Ac-2: mixed case")).toEqual({ "AC-1": "lowercase", "AC-2": "mixed case" });
    expect(parseACTextFromSpec("# Feature\n\nNo acceptance criteria here.")).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findRelatedStories
// ─────────────────────────────────────────────────────────────────────────────

describe("findRelatedStories", () => {
  test("finds stories with matching AC in acceptanceCriteria", () => {
    const prd = makePrd([
      makeStory("US-001", ["AC-1: handles empty input"]),
      makeStory("US-002", ["AC-2: TTL expiry", "AC-3: format validation"]),
      makeStory("US-003", ["AC-4: other criterion"]),
    ]);

    const related = findRelatedStories("AC-2", prd);

    expect(related).toEqual(["US-002"]);
  });

  test("falls back to passed stories only (not pending); limits fallback to 5", () => {
    const prd = makePrd([
      makeStory("US-001", ["other AC"], "passed"),
      makeStory("US-002", ["another AC"], "pending"),
      makeStory("US-003", ["yet another AC"], "passed"),
    ]);
    const related = findRelatedStories("AC-99", prd);
    expect(related).toContain("US-001");
    expect(related).toContain("US-003");
    expect(related).not.toContain("US-002");

    const manyStories: UserStory[] = Array.from({ length: 10 }, (_, i) => makeStory(`US-${String(i + 1).padStart(3, "0")}`, ["unrelated"]));
    expect(findRelatedStories("AC-99", makePrd(manyStories)).length).toBeLessThanOrEqual(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// groupACsByRelatedStories (D1: batching)
// ─────────────────────────────────────────────────────────────────────────────

describe("groupACsByRelatedStories", () => {
  test("groups ACs sharing the same related stories into one group", () => {
    const prd = makePrd([
      makeStory("US-001", ["AC-1: first", "AC-2: second"]),
      makeStory("US-002", ["AC-3: third"]),
    ]);

    const groups = groupACsByRelatedStories(["AC-1", "AC-2"], prd);

    // AC-1 and AC-2 both map to US-001 — one group
    expect(groups.length).toBe(1);
    expect(groups[0].acs).toContain("AC-1");
    expect(groups[0].acs).toContain("AC-2");
    expect(groups[0].relatedStories).toEqual(["US-001"]);
  });

  test("creates separate groups for ACs with different related stories", () => {
    const prd = makePrd([
      makeStory("US-001", ["AC-1: auth"]),
      makeStory("US-002", ["AC-2: i18n"]),
    ]);

    const groups = groupACsByRelatedStories(["AC-1", "AC-2"], prd);

    expect(groups.length).toBe(2);
  });

  test("caps at 8 groups by merging smallest when exceeded", () => {
    // Create 10 distinct stories each owning one AC
    const stories: UserStory[] = [];
    for (let i = 1; i <= 10; i++) {
      stories.push(makeStory(`US-${String(i).padStart(3, "0")}`, [`AC-${i}: criterion ${i}`]));
    }
    const prd = makePrd(stories);
    const failedACs = stories.map((_, i) => `AC-${i + 1}`);

    const groups = groupACsByRelatedStories(failedACs, prd);

    expect(groups.length).toBeLessThanOrEqual(8);
    // All ACs must still be represented
    const allACs = groups.flatMap((g) => g.acs);
    expect(allACs.length).toBe(10);
  });

  test("28 ACs with same related story produce 1 group (koda scenario)", () => {
    const prd = makePrd([makeStory("US-001", Array.from({ length: 28 }, (_, i) => `AC-${i + 1}: crit ${i + 1}`))]);
    const failedACs = Array.from({ length: 28 }, (_, i) => `AC-${i + 1}`);

    const groups = groupACsByRelatedStories(failedACs, prd);

    expect(groups.length).toBe(1);
    expect(groups[0].acs.length).toBe(28);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildFixPrompt (P1-A: enriched context)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFixPrompt", () => {
  test("builds prompt with all required context; instructs not to modify test file", () => {
    const prd = makePrd([makeStory("US-002", ["AC-2: TTL expiry"])]);
    prd.userStories[0].title = "Implement TTL";
    prd.userStories[0].description = "Add TTL support to key-value store";
    const prompt = buildFixPrompt(["AC-2"], { "AC-2": "set(key, value, ttl) expires after ttl milliseconds" }, "Expected undefined, got 'value'", ["US-002"], prd);
    expect(prompt).toContain("AC-2:");
    expect(prompt).toContain("set(key, value, ttl)");
    expect(prompt).toContain("Expected undefined, got 'value'");
    expect(prompt).toContain("US-002");
    expect(prompt).toContain("Implement TTL");
    expect(prompt).toContain("Add TTL support");
    expect(prompt.toLowerCase()).toContain("do not modify the test file");
  });

  test("includes test file path when provided; includes batched AC count in header", () => {
    const prd1 = makePrd([makeStory("US-001", ["AC-1: criterion"])]);
    const prompt1 = buildFixPrompt(["AC-1"], { "AC-1": "criterion" }, "fail output", ["US-001"], prd1, "/repo/nax/features/cache/acceptance.test.ts");
    expect(prompt1).toContain("ACCEPTANCE TEST FILE:");
    expect(prompt1).toContain("/repo/nax/features/cache/acceptance.test.ts");

    const prd2 = makePrd([makeStory("US-001", ["AC-1: a", "AC-2: b", "AC-3: c"])]);
    const prompt2 = buildFixPrompt(["AC-1", "AC-2", "AC-3"], { "AC-1": "a", "AC-2": "b", "AC-3": "c" }, "output", ["US-001"], prd2);
    expect(prompt2).toContain("3 total");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// convertFixStoryToUserStory (P1-A: enriched description, P1-C: workdir, D4)
// ─────────────────────────────────────────────────────────────────────────────

describe("convertFixStoryToUserStory", () => {
  test("converts FixStory to UserStory with correct base fields", () => {
    const fixStory = {
      id: "US-FIX-001",
      title: "Fix: AC-2 TTL expiry timing",
      failedAC: "AC-2",
      batchedACs: ["AC-2"],
      testOutput: "test output",
      relatedStories: ["US-002", "US-005"],
      description: "Update TTL implementation to properly expire entries after the specified duration.",
    };

    const userStory = convertFixStoryToUserStory(fixStory);

    expect(userStory.id).toBe("US-FIX-001");
    expect(userStory.title).toBe("Fix: AC-2 TTL expiry timing");
    expect(userStory.tags).toEqual(["fix", "acceptance-failure"]);
    expect(userStory.dependencies).toEqual(["US-002", "US-005"]);
    expect(userStory.status).toBe("pending");
    expect(userStory.passes).toBe(false);
    expect(userStory.escalations).toEqual([]);
    expect(userStory.attempts).toBe(0);
  });

  test("acceptance criteria list all batched ACs (P1-A)", () => {
    const fixStory = {
      id: "US-FIX-001",
      title: "Fix batch",
      failedAC: "AC-1",
      batchedACs: ["AC-1", "AC-2", "AC-5"],
      testOutput: "output",
      relatedStories: ["US-001"],
      description: "Fix desc",
    };

    const userStory = convertFixStoryToUserStory(fixStory);

    expect(userStory.acceptanceCriteria).toEqual(["Fix AC-1", "Fix AC-2", "Fix AC-5"]);
  });

  test("description includes test file path and truncated failure output", () => {
    const withPath = convertFixStoryToUserStory({ id: "US-FIX-001", title: "Fix", failedAC: "AC-1", batchedACs: ["AC-1"], testOutput: "fail output", relatedStories: ["US-001"], description: "Fix the thing", testFilePath: "/repo/nax/features/cache/acceptance.test.ts" });
    expect(withPath.description).toContain("ACCEPTANCE TEST FILE:");
    expect(withPath.description).toContain("/repo/nax/features/cache/acceptance.test.ts");

    const withOutput = convertFixStoryToUserStory({ id: "US-FIX-001", title: "Fix", failedAC: "AC-2", batchedACs: ["AC-2"], testOutput: "Expected undefined, got 'value'\nat AC-2 test...", relatedStories: ["US-001"], description: "Fix the thing" });
    expect(withOutput.description).toContain("TEST FAILURE OUTPUT:");
    expect(withOutput.description).toContain("Expected undefined");
  });

  test("description includes instructions not to modify test file (P1-A)", () => {
    const fixStory = {
      id: "US-FIX-001",
      title: "Fix",
      failedAC: "AC-1",
      batchedACs: ["AC-1"],
      testOutput: "output",
      relatedStories: ["US-001"],
      description: "Fix desc",
    };

    const userStory = convertFixStoryToUserStory(fixStory);

    expect(userStory.description.toLowerCase()).toContain("do not modify the test file");
  });

  test("inherits workdir when set; undefined when absent", () => {
    const base = { id: "US-FIX-001", title: "Fix", failedAC: "AC-1", batchedACs: ["AC-1"], testOutput: "output", relatedStories: ["US-001"], description: "Fix desc" };
    expect(convertFixStoryToUserStory({ ...base, workdir: "packages/api" }).workdir).toBe("packages/api");
    expect(convertFixStoryToUserStory(base).workdir).toBeUndefined();
  });

  test("falls back to failedAC when batchedACs not present (backward compat)", () => {
    const fixStory = {
      id: "US-FIX-001",
      title: "Fix: AC-2 TTL expiry timing",
      failedAC: "AC-2",
      batchedACs: undefined as unknown as string[],
      testOutput: "test output",
      relatedStories: ["US-002", "US-005"],
      description: "Update TTL implementation.",
    };

    const userStory = convertFixStoryToUserStory(fixStory);

    expect(userStory.acceptanceCriteria).toEqual(["Fix AC-2"]);
  });
});
