// RE-ARCH: keep
/**
 * Fix Generator Tests
 */

import { describe, expect, test } from "bun:test";
import {
  buildFixPrompt,
  convertFixStoryToUserStory,
  findRelatedStories,
  parseACTextFromSpec,
} from "../../../src/acceptance/fix-generator";
import type { PRD, UserStory } from "../../../src/prd/types";

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

  test("normalizes AC IDs to uppercase", () => {
    const spec = "- ac-1: lowercase\n- Ac-2: mixed case";

    const map = parseACTextFromSpec(spec);

    expect(map).toEqual({
      "AC-1": "lowercase",
      "AC-2": "mixed case",
    });
  });

  test("returns empty map when no ACs found", () => {
    const spec = "# Feature\n\nNo acceptance criteria here.";

    const map = parseACTextFromSpec(spec);

    expect(map).toEqual({});
  });
});

describe("findRelatedStories", () => {
  test("finds stories with matching AC in acceptanceCriteria", () => {
    const prd: PRD = {
      project: "test",
      feature: "test",
      branchName: "test",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
      userStories: [
        {
          id: "US-001",
          title: "First story",
          description: "desc",
          acceptanceCriteria: ["AC-1: handles empty input"],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-002",
          title: "Second story",
          description: "desc",
          acceptanceCriteria: ["AC-2: TTL expiry", "AC-3: format validation"],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-003",
          title: "Third story",
          description: "desc",
          acceptanceCriteria: ["AC-4: other criterion"],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
        },
      ],
    };

    const related = findRelatedStories("AC-2", prd);

    expect(related).toEqual(["US-002"]);
  });

  test("falls back to all passed stories when no AC match", () => {
    const prd: PRD = {
      project: "test",
      feature: "test",
      branchName: "test",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
      userStories: [
        {
          id: "US-001",
          title: "First",
          description: "desc",
          acceptanceCriteria: ["other AC"],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-002",
          title: "Second",
          description: "desc",
          acceptanceCriteria: ["another AC"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-003",
          title: "Third",
          description: "desc",
          acceptanceCriteria: ["yet another AC"],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
        },
      ],
    };

    const related = findRelatedStories("AC-99", prd);

    // Should return passed stories (max 5)
    expect(related).toContain("US-001");
    expect(related).toContain("US-003");
    expect(related).not.toContain("US-002"); // pending, not passed
  });

  test("limits fallback to 5 stories", () => {
    const stories: UserStory[] = [];
    for (let i = 1; i <= 10; i++) {
      stories.push({
        id: `US-${String(i).padStart(3, "0")}`,
        title: `Story ${i}`,
        description: "desc",
        acceptanceCriteria: ["unrelated"],
        tags: [],
        dependencies: [],
        status: "passed",
        passes: true,
        escalations: [],
        attempts: 0,
      });
    }

    const prd: PRD = {
      project: "test",
      feature: "test",
      branchName: "test",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
      userStories: stories,
    };

    const related = findRelatedStories("AC-99", prd);

    expect(related.length).toBeLessThanOrEqual(5);
  });
});

describe("buildFixPrompt", () => {
  test("builds prompt with all required context", () => {
    const prd: PRD = {
      project: "test",
      feature: "test",
      branchName: "test",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
      userStories: [
        {
          id: "US-002",
          title: "Implement TTL",
          description: "Add TTL support to key-value store",
          acceptanceCriteria: ["AC-2: TTL expiry"],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
        },
      ],
    };

    const prompt = buildFixPrompt(
      "AC-2",
      "set(key, value, ttl) expires after ttl milliseconds",
      "Expected undefined, got 'value'",
      ["US-002"],
      prd,
    );

    expect(prompt).toContain("AC-2:");
    expect(prompt).toContain("set(key, value, ttl)");
    expect(prompt).toContain("Expected undefined, got 'value'");
    expect(prompt).toContain("US-002");
    expect(prompt).toContain("Implement TTL");
    expect(prompt).toContain("Add TTL support");
  });
});

describe("convertFixStoryToUserStory", () => {
  test("converts FixStory to UserStory with correct fields", () => {
    const fixStory = {
      id: "US-FIX-001",
      title: "Fix: AC-2 TTL expiry timing",
      failedAC: "AC-2",
      testOutput: "test output",
      relatedStories: ["US-002", "US-005"],
      description: "Update TTL implementation to properly expire entries after the specified duration.",
    };

    const userStory = convertFixStoryToUserStory(fixStory);

    expect(userStory.id).toBe("US-FIX-001");
    expect(userStory.title).toBe("Fix: AC-2 TTL expiry timing");
    expect(userStory.description).toBe(
      "Update TTL implementation to properly expire entries after the specified duration.",
    );
    expect(userStory.acceptanceCriteria).toEqual(["Fix AC-2"]);
    expect(userStory.tags).toEqual(["fix", "acceptance-failure"]);
    expect(userStory.dependencies).toEqual(["US-002", "US-005"]);
    expect(userStory.status).toBe("pending");
    expect(userStory.passes).toBe(false);
    expect(userStory.escalations).toEqual([]);
    expect(userStory.attempts).toBe(0);
  });
});
