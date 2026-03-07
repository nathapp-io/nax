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
  describe("context isolation", () => {
    test("should only include current story and declared dependencies — no other stories", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Define core interfaces",
          description: "Create base interfaces for the module",
          acceptanceCriteria: ["Interface exported", "Types documented"],
          dependencies: [],
          status: "passed" as any,
          passes: true,
        },
        {
          id: "US-002",
          title: "Implement health service",
          description: "Service that aggregates indicators",
          acceptanceCriteria: ["Service injectable", "Aggregates results"],
          dependencies: [],
          status: "passed" as any,
          passes: true,
        },
        {
          id: "US-003",
          title: "Add HTTP indicator",
          description: "HTTP health check indicator",
          acceptanceCriteria: ["Pings endpoint", "Returns status"],
          dependencies: ["US-001"],
        },
        {
          id: "US-004",
          title: "Add database indicator",
          description: "Database connectivity check",
          acceptanceCriteria: ["Checks DB connection", "Timeout support"],
          dependencies: ["US-001"],
        },
        {
          id: "US-005",
          title: "REST endpoint",
          description: "Expose health check via REST API",
          acceptanceCriteria: ["GET /health returns JSON", "Includes all indicators"],
          dependencies: ["US-002", "US-003"],
        },
      ]);

      // Build context for US-003 which depends only on US-001
      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-003",
      };

      const budget: ContextBudget = {
        maxTokens: 50000,
        reservedForInstructions: 5000,
        availableForContext: 45000,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      // Current story IS present
      expect(markdown).toContain("US-003");
      expect(markdown).toContain("Add HTTP indicator");

      // Declared dependency IS present
      expect(markdown).toContain("US-001");
      expect(markdown).toContain("Define core interfaces");

      // Non-dependency stories are NOT present
      expect(markdown).not.toContain("US-002");
      expect(markdown).not.toContain("Implement health service");
      expect(markdown).not.toContain("US-004");
      expect(markdown).not.toContain("Add database indicator");
      expect(markdown).not.toContain("US-005");
      expect(markdown).not.toContain("REST endpoint");

      // Acceptance criteria from other stories are NOT leaked
      expect(markdown).not.toContain("Aggregates results");
      expect(markdown).not.toContain("Checks DB connection");
      expect(markdown).not.toContain("Includes all indicators");
    });

    test("progress summary contains only aggregate counts, not story titles or IDs", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Secret Story Alpha",
          description: "Should not appear in progress",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
          status: "passed" as any,
          passes: true,
        },
        {
          id: "US-002",
          title: "Secret Story Beta",
          description: "Also should not appear",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
          status: "failed" as any,
          passes: false,
        },
        {
          id: "US-003",
          title: "Current Story",
          description: "The one being built",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-003",
      };

      const budget: ContextBudget = {
        maxTokens: 50000,
        reservedForInstructions: 5000,
        availableForContext: 45000,
      };

      const built = await buildContext(storyContext, budget);
      const progressElement = built.elements.find((e) => e.type === "progress");

      expect(progressElement).toBeDefined();
      // Progress shows counts only
      expect(progressElement!.content).toContain("2/3");
      // Does NOT contain other story titles
      expect(progressElement!.content).not.toContain("Secret Story Alpha");
      expect(progressElement!.content).not.toContain("Secret Story Beta");
      expect(progressElement!.content).not.toContain("US-001");
      expect(progressElement!.content).not.toContain("US-002");
    });

    test("prior errors from other stories do not leak into current story context", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Story with errors",
          description: "Has prior errors",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
          priorErrors: ["LEAKED_ERROR: something broke in US-001"],
        },
        {
          id: "US-002",
          title: "Clean story",
          description: "No errors here",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-002",
      };

      const budget: ContextBudget = {
        maxTokens: 50000,
        reservedForInstructions: 5000,
        availableForContext: 45000,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).not.toContain("LEAKED_ERROR");
      expect(markdown).not.toContain("US-001");
      // No error section at all
      expect(markdown).not.toContain("## Prior Errors");
    });

    test("context elements only contain expected types for a story with no deps/errors", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Solo story",
          description: "No dependencies",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 50000,
        reservedForInstructions: 5000,
        availableForContext: 45000,
      };

      const built = await buildContext(storyContext, budget);

      // Should only have progress + current story (no deps, no errors, no files, no test-coverage without workdir)
      const types = built.elements.map((e) => e.type);
      expect(types).toContain("progress");
      expect(types).toContain("story");
      expect(types).not.toContain("dependency");
      expect(types).not.toContain("error");

      // All story elements reference only US-001
      const storyElements = built.elements.filter((e) => e.storyId);
      for (const el of storyElements) {
        expect(el.storyId).toBe("US-001");
      }
    });
  });
});
