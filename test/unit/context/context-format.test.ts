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
  describe("formatContextAsMarkdown", () => {
    test("should format context with all element types", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Dependency",
          description: "Dep description",
          acceptanceCriteria: ["AC1"],
          status: "passed",
          passes: true,
        },
        {
          id: "US-002",
          title: "Current",
          description: "Current description",
          acceptanceCriteria: ["AC2"],
          dependencies: ["US-001"],
          priorErrors: ["Test error"],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-002",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain("# Story Context");
      expect(markdown).toContain("## Progress");
      expect(markdown).toContain("## Prior Errors");
      expect(markdown).toContain("## Current Story");
      expect(markdown).toContain("## Dependency Stories");
      expect(markdown).toContain("US-001");
      expect(markdown).toContain("US-002");
      expect(markdown).toContain("Test error");
    });

    test("should include summary with token count", async () => {
      const prd = createTestPRD([{ id: "US-001", title: "Story" }]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain("Context:");
      expect(markdown).toContain("tokens");
      expect(markdown).toContain(built.totalTokens.toString());
    });

    test("should show truncation indicator", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          description: "x".repeat(2000),
          dependencies: ["US-002", "US-003"],
        },
        { id: "US-002", description: "x".repeat(2000) },
        { id: "US-003", description: "x".repeat(2000) },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 500,
        reservedForInstructions: 250,
        availableForContext: 250,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      expect(markdown).toContain("[TRUNCATED]");
    });

    test("should format context with file elements", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        await fs.writeFile(path.join(tempDir, "helper.ts"), "export function helper() {}");

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Story with File",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            contextFiles: ["helper.ts"],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);
        const markdown = formatContextAsMarkdown(built);

        expect(markdown).toContain("# Story Context");
        expect(markdown).toContain("## Relevant Source Files");
        expect(markdown).toContain("helper.ts");
        expect(markdown).toContain("helper()");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should format ASSET_CHECK_FAILED errors as mandatory instructions", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Story with asset check failure",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          priorErrors: [
            "ASSET_CHECK_FAILED: Missing files: [src/finder.ts, test/finder.test.ts]\nAction: Create the missing files before tests can run.",
          ],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      // Verify ASSET_CHECK errors are formatted prominently
      expect(markdown).toContain("⚠️ MANDATORY: Missing Files from Previous Attempts");
      expect(markdown).toContain("CRITICAL");
      expect(markdown).toContain("You MUST create these exact files");
      expect(markdown).toContain("Do NOT use alternative filenames");
      expect(markdown).toContain("**Required files:**");
      expect(markdown).toContain("`src/finder.ts`");
      expect(markdown).toContain("`test/finder.test.ts`");

      // Verify it's NOT in the generic "Prior Errors" section
      expect(markdown).not.toContain("## Prior Errors");
    });

    test("should format mixed ASSET_CHECK and other errors separately", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Story with multiple error types",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          priorErrors: [
            "ASSET_CHECK_FAILED: Missing files: [src/utils.ts]\nAction: Create the missing files before tests can run.",
            'TypeError: Cannot read property "foo" of undefined',
            "Test execution failed",
          ],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      // Verify ASSET_CHECK errors section exists
      expect(markdown).toContain("⚠️ MANDATORY: Missing Files from Previous Attempts");
      expect(markdown).toContain("`src/utils.ts`");

      // Verify other errors are in separate section
      expect(markdown).toContain("## Prior Errors");
      expect(markdown).toContain('TypeError: Cannot read property "foo" of undefined');
      expect(markdown).toContain("Test execution failed");
    });

    test("should handle non-ASSET_CHECK errors normally", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Story with regular errors",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          priorErrors: ['TypeError: Cannot read property "foo" of undefined', "Test execution failed"],
        },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);
      const markdown = formatContextAsMarkdown(built);

      // Verify only "Prior Errors" section exists (no MANDATORY section)
      expect(markdown).toContain("## Prior Errors");
      expect(markdown).toContain('TypeError: Cannot read property "foo" of undefined');
      expect(markdown).toContain("Test execution failed");
      expect(markdown).not.toContain("⚠️ MANDATORY");
    });
  });
});
