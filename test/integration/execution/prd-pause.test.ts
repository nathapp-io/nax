import { describe, expect, test } from "bun:test";
import { countStories, generateHumanHaltSummary, getNextStory, isStalled, markStoryPaused } from "../../../src/prd";
import type { PRD } from "../../../src/prd/types";

describe("PRD pause functionality", () => {
  const createTestPRD = (): PRD => ({
    project: "test-project",
    feature: "test-feature",
    branchName: "feature/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [
      {
        id: "US-001",
        title: "Story 1",
        description: "First story",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
      {
        id: "US-002",
        title: "Story 2",
        description: "Second story",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
      {
        id: "US-003",
        title: "Story 3",
        description: "Third story depends on US-001",
        acceptanceCriteria: ["AC3"],
        tags: [],
        dependencies: ["US-001"],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ],
    analyzeConfig: {
      llmEnhanced: false,
      model: "balanced",
      fallbackToKeywords: true,
      maxCodebaseSummaryTokens: 5000,
    },
  });

  describe("markStoryPaused", () => {
    test("marks story as paused", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");
      expect(prd.userStories[0].status).toBe("paused");
    });

    test("does nothing if story not found", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-999");
      // Should not throw, just silently ignore
      expect(prd.userStories[0].status).toBe("pending");
    });
  });

  describe("getNextStory", () => {
    test("skips paused stories", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");

      const next = getNextStory(prd);
      expect(next?.id).toBe("US-002");
    });

    test("returns non-dependent story when dependency is paused", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");

      // US-003 depends on US-001 which is paused, so should get US-002
      const next = getNextStory(prd);
      expect(next?.id).toBe("US-002");
    });

    test("returns null when all stories are paused", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");
      markStoryPaused(prd, "US-002");
      markStoryPaused(prd, "US-003");

      const next = getNextStory(prd);
      expect(next).toBeNull();
    });

    test("returns dependent story after paused dependency is completed", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");

      // Mark US-001 as passed (unpaused and completed)
      prd.userStories[0].status = "passed";
      prd.userStories[0].passes = true;

      // Complete US-002
      prd.userStories[1].status = "passed";
      prd.userStories[1].passes = true;

      // Now US-003 should be available
      const next = getNextStory(prd);
      expect(next?.id).toBe("US-003");
    });
  });

  describe("countStories", () => {
    test("counts paused stories", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");
      markStoryPaused(prd, "US-002");

      const counts = countStories(prd);
      expect(counts.paused).toBe(2);
      expect(counts.pending).toBe(1); // US-003 is still pending
      expect(counts.total).toBe(3);
    });

    test("excludes paused stories from pending count", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");

      const counts = countStories(prd);
      expect(counts.pending).toBe(2); // US-002 and US-003
      expect(counts.paused).toBe(1);
    });
  });

  describe("isStalled", () => {
    test("returns true when all stories are paused", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");
      markStoryPaused(prd, "US-002");
      markStoryPaused(prd, "US-003");

      expect(isStalled(prd)).toBe(true);
    });

    test("returns false when at least one story can proceed", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");
      // US-002 has no dependencies, should not be stalled

      expect(isStalled(prd)).toBe(false);
    });

    test("returns true when remaining stories depend on paused stories", () => {
      const prd = createTestPRD();

      // Complete US-002
      prd.userStories[1].status = "passed";
      prd.userStories[1].passes = true;

      // Pause US-001
      markStoryPaused(prd, "US-001");

      // US-003 depends on US-001 which is paused, so it's stalled
      expect(isStalled(prd)).toBe(true);
    });

    test("returns false when stories complete while others are paused", () => {
      const prd = createTestPRD();

      // Pause US-003 (has dependency)
      markStoryPaused(prd, "US-003");

      // US-001 and US-002 can still proceed (no dependencies)
      expect(isStalled(prd)).toBe(false);
    });
  });

  describe("generateHumanHaltSummary", () => {
    test("includes paused stories in summary", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");
      markStoryPaused(prd, "US-002");

      const summary = generateHumanHaltSummary(prd);
      expect(summary).toContain("Paused (2):");
      expect(summary).toContain("US-001: Story 1");
      expect(summary).toContain("US-002: Story 2");
    });

    test("shows stories waiting on paused dependencies", () => {
      const prd = createTestPRD();
      markStoryPaused(prd, "US-001");

      const summary = generateHumanHaltSummary(prd);
      expect(summary).toContain("Waiting on blocked/paused dependencies");
      expect(summary).toContain("US-003");
    });
  });
});
