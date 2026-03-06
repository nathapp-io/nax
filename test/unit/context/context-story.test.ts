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
      expect(element.content).toContain("US-002: Dependency Story");
      expect(element.tokens).toBeGreaterThan(0);
    });
  });
});
