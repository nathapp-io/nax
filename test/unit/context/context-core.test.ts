// RE-ARCH: keep
/**
 * Tests for context builder module — core element factories and utilities
 */

import { describe, expect, test } from "bun:test";
import {
  buildContext,
  createDependencyContext,
  createErrorContext,
  createFileContext,
  createProgressContext,
  createStoryContext,
  estimateTokens,
  sortContextElements,
} from "../../../src/context";
import type { ContextBudget, ContextElement, StoryContext } from "../../../src/context/types";
import type { PRD, UserStory } from "../../../src/prd";

// Helper to create test PRD
const createTestPRD = (stories: Partial<UserStory>[]): PRD => ({
  project: "test-project",
  feature: "test-feature",
  branchName: "test-branch",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: stories.map((s, i) => ({
    id: s.id || `US-${String(i + 1).padStart(3, "0")}`,
    title: s.title || "Test Story",
    description: s.description || "Test description",
    acceptanceCriteria: s.acceptanceCriteria || ["AC1"],
    dependencies: s.dependencies || [],
    tags: s.tags || [],
    status: s.status || "pending",
    passes: s.passes ?? false,
    escalations: s.escalations || [],
    attempts: s.attempts || 0,
    routing: s.routing,
    priorErrors: s.priorErrors,
    relevantFiles: s.relevantFiles,
    contextFiles: s.contextFiles,
    expectedFiles: s.expectedFiles,
  })),
});

describe("Context Builder", () => {
  describe("estimateTokens", () => {
    test("should estimate tokens correctly", () => {
      expect(estimateTokens("test")).toBe(1); // 4 chars = 1 token (1 token ≈ 4 chars)
      expect(estimateTokens("hello world")).toBe(3); // 11 chars = 3 tokens (rounded up)
      expect(estimateTokens("")).toBe(0);
    });
  });

  describe("createStoryContext", () => {
    test("should create story context element", () => {
      const story: UserStory = {
        id: "US-001",
        title: "Test Story",
        description: "Test description",
        acceptanceCriteria: ["AC1", "AC2"],
        dependencies: [],
        tags: ["feature"],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      };

      const element = createStoryContext(story, 80);

      expect(element.type).toBe("story");
      expect(element.storyId).toBe("US-001");
      expect(element.priority).toBe(80);
      expect(element.content).toContain("US-001: Test Story");
      expect(element.content).toContain("Test description");
      expect(element.content).toContain("AC1");
      expect(element.content).toContain("AC2");
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe("createDependencyContext", () => {
    test("should create dependency context element", () => {
      const story: UserStory = {
        id: "US-002",
        title: "Dependency Story",
        description: "Dependency description",
        acceptanceCriteria: ["AC1"],
        dependencies: [],
        tags: [],
        status: "passed",
        passes: true,
        escalations: [],
        attempts: 0,
      };

      const element = createDependencyContext(story, 50);

      expect(element.type).toBe("dependency");
      expect(element.storyId).toBe("US-002");
      expect(element.priority).toBe(50);
      expect(element.content).toContain("US-002 (passed): Dependency Story");
      expect(element.tokens).toBeGreaterThan(0);
    });

    test("passed dependency uses compact format — omits full AC list", () => {
      const story: UserStory = {
        id: "US-002",
        title: "Add VcsPrStatus type",
        description: "Define VcsPrStatus interface",
        acceptanceCriteria: ["AC1", "AC2", "AC3", "AC4", "AC5"],
        dependencies: [],
        tags: [],
        status: "passed",
        passes: true,
        escalations: [],
        attempts: 0,
      };

      const element = createDependencyContext(story, 50);

      expect(element.content).toContain("US-002 (passed): Add VcsPrStatus type");
      expect(element.content).not.toContain("**Acceptance Criteria:**");
      expect(element.content).not.toContain("**Description:**");
    });

    test("passed dependency with diffSummary includes changes block", () => {
      const story: UserStory = {
        id: "US-002",
        title: "Add VcsPrStatus type",
        description: "Define VcsPrStatus interface",
        acceptanceCriteria: ["AC1"],
        dependencies: [],
        tags: [],
        status: "passed",
        passes: true,
        escalations: [],
        attempts: 0,
        diffSummary: "src/vcs/types.ts | 12 ++",
      };

      const element = createDependencyContext(story, 50);

      expect(element.content).toContain("**Changes made:**");
      expect(element.content).toContain("src/vcs/types.ts | 12 ++");
      expect(element.content).not.toContain("**Acceptance Criteria:**");
    });

    test("passed dependency without diffSummary shows fallback message", () => {
      const story: UserStory = {
        id: "US-002",
        title: "Add VcsPrStatus type",
        description: "Define VcsPrStatus interface",
        acceptanceCriteria: ["AC1"],
        dependencies: [],
        tags: [],
        status: "passed",
        passes: true,
        escalations: [],
        attempts: 0,
      };

      const element = createDependencyContext(story, 50);

      expect(element.content).toContain("no diff summary available");
    });

    test("decomposed dependency uses compact format", () => {
      const story: UserStory = {
        id: "US-001",
        title: "Parent Story",
        description: "Parent story description",
        acceptanceCriteria: ["AC1", "AC2"],
        dependencies: [],
        tags: [],
        status: "decomposed",
        passes: false,
        escalations: [],
        attempts: 0,
      };

      const element = createDependencyContext(story, 50);

      expect(element.content).toContain("US-001 (decomposed): Parent Story");
      expect(element.content).not.toContain("**Acceptance Criteria:**");
    });

    test("pending dependency uses full format with AC list", () => {
      const story: UserStory = {
        id: "US-003",
        title: "Pending Dependency",
        description: "Not done yet",
        acceptanceCriteria: ["AC1", "AC2"],
        dependencies: [],
        tags: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      };

      const element = createDependencyContext(story, 50);

      expect(element.content).toContain("**Acceptance Criteria:**");
      expect(element.content).toContain("AC1");
      expect(element.content).toContain("AC2");
    });
  });

  describe("createErrorContext", () => {
    test("should create error context element", () => {
      const error = "TypeError: Cannot read property";
      const element = createErrorContext(error, 90);

      expect(element.type).toBe("error");
      expect(element.content).toBe(error);
      expect(element.priority).toBe(90);
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe("createProgressContext", () => {
    test("should create progress context element", () => {
      const progress = "Progress: 5/12 stories complete (4 passed, 1 failed)";
      const element = createProgressContext(progress, 100);

      expect(element.type).toBe("progress");
      expect(element.content).toBe(progress);
      expect(element.priority).toBe(100);
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe("createFileContext", () => {
    test("should create file context element", () => {
      const filePath = "src/utils/helper.ts";
      const content = 'export function helper() { return "test"; }';
      const element = createFileContext(filePath, content, 60);

      expect(element.type).toBe("file");
      expect(element.filePath).toBe(filePath);
      expect(element.content).toBe(content);
      expect(element.priority).toBe(60);
      expect(element.tokens).toBeGreaterThan(0);
    });
  });

  describe("sortContextElements", () => {
    test("should sort by priority descending", () => {
      const elements: ContextElement[] = [
        createErrorContext("error", 10),
        createProgressContext("progress", 100),
        createErrorContext("error2", 50),
      ];

      const sorted = sortContextElements(elements);

      expect(sorted[0].priority).toBe(100);
      expect(sorted[1].priority).toBe(50);
      expect(sorted[2].priority).toBe(10);
    });

    test("should sort by tokens ascending for same priority", () => {
      const elements: ContextElement[] = [
        createErrorContext("this is a much longer error message with lots of text", 50),
        createErrorContext("short", 50),
        createErrorContext("medium length message", 50),
      ];

      const sorted = sortContextElements(elements);

      expect(sorted[0].tokens).toBeLessThan(sorted[1].tokens);
      expect(sorted[1].tokens).toBeLessThan(sorted[2].tokens);
    });

    test("should not mutate original array", () => {
      const elements: ContextElement[] = [createErrorContext("a", 10), createErrorContext("b", 20)];

      const original = [...elements];
      sortContextElements(elements);

      expect(elements).toEqual(original);
    });
  });

  describe("defensive checks", () => {
    test("should handle story with null acceptanceCriteria", async () => {
      // Create PRD directly to bypass helper defaults
      const prd: PRD = {
        project: "test-project",
        feature: "test-feature",
        branchName: "test-branch",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [
          {
            id: "US-001",
            title: "Malformed Story",
            description: "Test",
            acceptanceCriteria: null as any, // Simulate malformed data
            dependencies: [],
            tags: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
          },
        ],
      };

      const context: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(context, budget);
      expect(built.elements.length).toBeGreaterThan(0);
      const storyElement = built.elements.find((e) => e.type === "story");
      expect(storyElement?.content).toContain("(No acceptance criteria defined)");
    });

    test("should handle story with undefined acceptanceCriteria", async () => {
      const prd: PRD = {
        project: "test-project",
        feature: "test-feature",
        branchName: "test-branch",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [
          {
            id: "US-001",
            title: "Malformed Story",
            description: "Test",
            acceptanceCriteria: undefined as any, // Simulate malformed data
            dependencies: [],
            tags: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
          },
        ],
      };

      const context: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(context, budget);
      expect(built.elements.length).toBeGreaterThan(0);
      const storyElement = built.elements.find((e) => e.type === "story");
      expect(storyElement?.content).toContain("(No acceptance criteria defined)");
    });

    test("should log warning for missing dependency story", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Story with Missing Dependency",
          description: "Test",
          acceptanceCriteria: ["AC1"],
          dependencies: ["US-999"], // Non-existent dependency
        },
      ]);

      const context: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(context, budget);

      // Should not include the missing dependency in the context
      expect(built.elements.find((e) => e.type === "dependency")).toBeUndefined();
    });

    test("should handle story with non-array priorErrors", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Story with Malformed Errors",
          description: "Test",
          acceptanceCriteria: ["AC1"],
          priorErrors: "not an array" as any, // Malformed data
        },
      ]);

      const context: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(context, budget);
      expect(built.elements.find((e) => e.type === "error")).toBeUndefined();
    });
  });
});
