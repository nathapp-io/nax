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
});
