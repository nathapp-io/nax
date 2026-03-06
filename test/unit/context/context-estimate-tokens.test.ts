// RE-ARCH: keep
/**
 * Tests for context builder module
 */

// RE-ARCH: keep
/**
 * Tests for context builder module
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildContext,
  createDependencyContext,
  createErrorContext,
  createFileContext,
  createProgressContext,
  createStoryContext,
  estimateTokens,
  formatContextAsMarkdown,
  sortContextElements,
} from "../../../src/context/builder";
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
      expect(estimateTokens("test")).toBe(2); // 4 chars = 2 tokens (1 token ≈ 3 chars)
      expect(estimateTokens("hello world")).toBe(4); // 11 chars = 4 tokens
      expect(estimateTokens("")).toBe(0);
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
