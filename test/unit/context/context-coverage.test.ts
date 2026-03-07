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
  describe("test coverage scoping", () => {
    test("should scope test coverage to story contextFiles", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        // Create test directory and files
        const testDir = path.join(tempDir, "test");
        await fs.mkdir(testDir);

        // Create multiple test files
        await fs.writeFile(
          path.join(testDir, "health.service.test.ts"),
          'describe("Health Service", () => { test("checks health", () => {}); });',
        );
        await fs.writeFile(
          path.join(testDir, "auth.service.test.ts"),
          'describe("Auth Service", () => { test("authenticates", () => {}); });',
        );
        await fs.writeFile(
          path.join(testDir, "db.connection.test.ts"),
          'describe("DB Connection", () => { test("connects", () => {}); });',
        );

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Implement health service",
            description: "Create health check service",
            acceptanceCriteria: ["Service works"],
            contextFiles: ["src/health.service.ts"], // Only health service
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              testCoverage: {
                enabled: true,
                scopeToStory: true, // Enable scoping
              },
            },
          } as any,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);
        const markdown = formatContextAsMarkdown(built);

        // Should include test coverage element
        expect(built.elements.some((e) => e.type === "test-coverage")).toBe(true);

        // Should only mention health.service.test.ts, not auth or db tests
        expect(markdown).toContain("health.service.test.ts");
        expect(markdown).not.toContain("auth.service.test.ts");
        expect(markdown).not.toContain("db.connection.test.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should scan all tests when scopeToStory=false", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        const testDir = path.join(tempDir, "test");
        await fs.mkdir(testDir);

        await fs.writeFile(
          path.join(testDir, "health.test.ts"),
          'describe("Health", () => { test("works", () => {}); });',
        );
        await fs.writeFile(path.join(testDir, "auth.test.ts"), 'describe("Auth", () => { test("works", () => {}); });');

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Story",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            contextFiles: ["src/health.ts"],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              testCoverage: {
                enabled: true,
                scopeToStory: false, // Disabled - should scan all
              },
            },
          } as any,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);
        const markdown = formatContextAsMarkdown(built);

        // Should include both test files
        expect(markdown).toContain("health.test.ts");
        expect(markdown).toContain("auth.test.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should fall back to full scan when no contextFiles provided", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        const testDir = path.join(tempDir, "test");
        await fs.mkdir(testDir);

        await fs.writeFile(
          path.join(testDir, "test1.test.ts"),
          'describe("Test1", () => { test("works", () => {}); });',
        );
        await fs.writeFile(
          path.join(testDir, "test2.test.ts"),
          'describe("Test2", () => { test("works", () => {}); });',
        );

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Story without contextFiles",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            // No contextFiles
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              testCoverage: {
                enabled: true,
                scopeToStory: true, // true but no contextFiles
              },
            },
          } as any,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);
        const markdown = formatContextAsMarkdown(built);

        // Should fall back to scanning all files
        expect(markdown).toContain("test1.test.ts");
        expect(markdown).toContain("test2.test.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

});
