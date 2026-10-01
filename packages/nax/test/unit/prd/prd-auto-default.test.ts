// RE-ARCH: keep
/**
 * PRD Auto-Default Tests (US-006 / BUG-004)
 *
 * Tests for PRD loader auto-defaulting and router defensive fallbacks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { loadPRD, savePRD } from "@/prd";
import type { PersistedRepoScopedFix, PRD, UserStory } from "@/prd/types";
import { routeTask } from "@/routing";

/**
 * Wire-format view of a story in which the loader-defaulted fields are optional,
 * matching how older or hand-edited prd.json files actually look on disk.
 */
type DefaultedFields = "tags" | "status" | "acceptanceCriteria" | "dependencies" | "escalations" | "attempts";
type WireUserStory = Omit<UserStory, DefaultedFields> & {
  [K in DefaultedFields]?: UserStory[K];
};

/**
 * Removes a defaulted field through the wire-format alias so `savePRD` writes JSON
 * with that key absent — the omission these loader tests exercise.
 */
function omitDefaultedField<K extends DefaultedFields>(story: UserStory, key: K): void {
  const wire: WireUserStory = story;
  delete wire[key];
}

// BUG-004
describe("PRD Auto-Default — missing fields are defaulted on load", () => {
  let testDir: string;
  let prdPath: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-prd-");
    prdPath = join(testDir, "test-prd.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("loadPRD auto-defaults missing tags to []", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test description",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };
    omitDefaultedField(story, "tags");
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].tags).toEqual([]);
  });

  test("loadPRD auto-defaults missing status to pending", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test description",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };
    omitDefaultedField(story, "status");
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].status).toBe("pending");
  });

  test("loadPRD auto-defaults missing acceptanceCriteria to []", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test description",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };
    omitDefaultedField(story, "acceptanceCriteria");
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].acceptanceCriteria).toEqual([]);
  });

  test("loadPRD auto-defaults missing storyPoints to 1", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
          // storyPoints intentionally omitted (optional in UserStory)
        },
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].storyPoints).toBe(1);
  });

  test("loadPRD preserves existing values", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC1", "AC2"],
          tags: ["security", "auth"],
          dependencies: ["US-000"],
          status: "in-progress",
          passes: false,
          escalations: [],
          attempts: 2,
          storyPoints: 5,
        },
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].acceptanceCriteria).toEqual(["AC1", "AC2"]);
    expect(loaded.userStories[0].tags).toEqual(["security", "auth"]);
    expect(loaded.userStories[0].dependencies).toEqual(["US-000"]);
    expect(loaded.userStories[0].status).toBe("in-progress");
    expect(loaded.userStories[0].attempts).toBe(2);
    expect(loaded.userStories[0].storyPoints).toBe(5);
  });

  test("loadPRD does not modify PRD file on disk", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test description",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };
    omitDefaultedField(story, "tags");
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    await savePRD(prd, prdPath);
    const originalContent = await Bun.file(prdPath).text();

    // Load the PRD (which will auto-default in-memory)
    await loadPRD(prdPath);

    // Verify file content unchanged
    const afterLoadContent = await Bun.file(prdPath).text();
    expect(afterLoadContent).toBe(originalContent);
  });

  test("strips suggestedCriteria: [] to undefined in loadPRD (#336 gap 1)", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          suggestedCriteria: [] as string[],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].suggestedCriteria).toBeUndefined();
  });

  test("preserves non-empty suggestedCriteria in loadPRD", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          suggestedCriteria: ["edge case A", "edge case B"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].suggestedCriteria).toEqual(["edge case A", "edge case B"]);
  });

  test("loadPRD handles all missing fields simultaneously", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test description",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };
    omitDefaultedField(story, "tags");
    omitDefaultedField(story, "status");
    omitDefaultedField(story, "acceptanceCriteria");
    omitDefaultedField(story, "dependencies");
    omitDefaultedField(story, "escalations");
    omitDefaultedField(story, "attempts");
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].tags).toEqual([]);
    expect(loaded.userStories[0].status).toBe("pending");
    expect(loaded.userStories[0].acceptanceCriteria).toEqual([]);
    expect(loaded.userStories[0].dependencies).toEqual([]);
    expect(loaded.userStories[0].attempts).toBe(0);
    expect(loaded.userStories[0].priorErrors).toEqual([]);
    expect(loaded.userStories[0].escalations).toEqual([]);
    expect(loaded.userStories[0].storyPoints).toBe(1);
  });
});

// BUG-004
describe("Router Tags Defensive Fallback — undefined and null tags handled gracefully", () => {
  /**
   * Reads tags the way a hand-edited or legacy prd.json delivers them: the value
   * crosses the untyped JSON boundary before routeTask's defensive fallback sees it.
   */
  const tagsFromDisk = (json: string) => JSON.parse(json);

  test("routeTask handles undefined tags gracefully", () => {
    const result = routeTask(
      "Fix typo",
      "Fix a typo in README",
      ["Typo fixed"],
      // Simulate tags key absent on disk
      tagsFromDisk("{}").tags,
      DEFAULT_CONFIG,
    );

    expect(result.complexity).toBe("simple");
    expect(result.modelTier).toBe("fast");
    expect(result.testStrategy).toBe("tdd-simple");
  });

  test("routeTask handles null tags gracefully", () => {
    const result = routeTask(
      "Fix typo",
      "Fix a typo in README",
      ["Typo fixed"],
      // Simulate explicit null tags on disk
      tagsFromDisk("null"),
      DEFAULT_CONFIG,
    );

    expect(result.complexity).toBe("simple");
    expect(result.modelTier).toBe("fast");
    expect(result.testStrategy).toBe("tdd-simple");
  });

  test("routeTask with undefined tags does not crash on spread operation", () => {
    // This test specifically verifies line ~277 in router.ts doesn't crash
    expect(() => {
      routeTask("Add feature", "Add new feature", ["AC1", "AC2", "AC3"], tagsFromDisk("{}").tags, DEFAULT_CONFIG);
    }).not.toThrow();
  });

  test("routeTask preserves existing tags behavior", () => {
    const result = routeTask("Auth fix", "Fix JWT auth bypass", ["Auth works"], ["security", "auth"], DEFAULT_CONFIG);

    expect(result.complexity).toBe("complex");
    expect(result.testStrategy).toBe("three-session-tdd");
    expect(result.reasoning).toContain("security-critical");
  });
});

// US-001 / #1654 — PersistedRepoScopedFix round-trip + absent-field
describe("PersistedRepoScopedFix — savePRD / loadPRD round-trip (AC1/AC2)", () => {
  let testDir: string;
  let prdPath: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-prsrf-");
    prdPath = join(testDir, "prd.json");
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  function makeFix(overrides: Partial<PersistedRepoScopedFix> = {}): PersistedRepoScopedFix {
    return {
      triggeringTests: ["src/foo.test.ts::reproduces bug"],
      filesChanged: ["src/foo.ts"],
      findingsCleared: true,
      ...overrides,
    };
  }

  test("AC1: savePRD then loadPRD preserves a single PersistedRepoScopedFix deep-equals", async () => {
    const fix = makeFix();
    const prd: PRD = {
      project: "test",
      feature: "test-feature",
      branchName: "feature/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: [],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
          repoScopedFixes: [fix],
        },
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].repoScopedFixes).toEqual([fix]);
  });

  test("AC1: savePRD then loadPRD preserves multiple fixes in order", async () => {
    const fixA = makeFix({ triggeringTests: ["a.test.ts::t1"], filesChanged: ["src/a.ts"] });
    const fixB = makeFix({
      triggeringTests: ["b.test.ts::t2"],
      filesChanged: ["src/b.ts"],
      findingsCleared: false,
    });
    const prd: PRD = {
      project: "test",
      feature: "test-feature",
      branchName: "feature/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: [],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
          repoScopedFixes: [fixA, fixB],
        },
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].repoScopedFixes).toEqual([fixA, fixB]);
    expect(loaded.userStories[0].repoScopedFixes?.[1].findingsCleared).toBe(false);
  });

  test("AC2: loadPRD leaves repoScopedFixes undefined when omitted from disk", async () => {
    const prd: PRD = {
      project: "test",
      feature: "test-feature",
      branchName: "feature/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: [],
          tags: [],
          dependencies: [],
          status: "failed",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ],
    };
    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].repoScopedFixes).toBeUndefined();
  });

  test("AC2: loadPRD leaves repoScopedFixes undefined for every story when none carry the field", async () => {
    const prd: PRD = {
      project: "test",
      feature: "test-feature",
      branchName: "feature/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: [],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-002",
          title: "Test story 2",
          description: "Test description 2",
          acceptanceCriteria: [],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
        },
      ],
    };
    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].repoScopedFixes).toBeUndefined();
    expect(loaded.userStories[1].repoScopedFixes).toBeUndefined();
  });
});
