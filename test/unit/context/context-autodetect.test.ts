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
  describe("context auto-detection (BUG-006)", () => {
    test("should auto-detect files when contextFiles is empty", async () => {
      // Create temp git repo
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        // Initialize git
        await Bun.spawn(["git", "init"], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: tempDir }).exited;

        // Create files matching story keywords
        await fs.mkdir(path.join(tempDir, "src/routing"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "src/routing/router.ts"), "export class Router { /* routing logic */ }");
        await fs.writeFile(
          path.join(tempDir, "src/routing/chain.ts"),
          "export class RouterChain { /* chain logic */ }",
        );

        // Commit so git grep can find them
        await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing chain bug",
            description: "Fix issue in router chain",
            acceptanceCriteria: ["Router chain works correctly"],
            // No contextFiles - should auto-detect
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              fileInjection: "keyword",
              autoDetect: {
                enabled: true,
                maxFiles: 5,
                traceImports: false,
              },
              testCoverage: {
                enabled: false, // Disable to isolate auto-detect test
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
        const fileElements = built.elements.filter((e) => e.type === "file");

        // Should auto-detect routing files
        expect(fileElements.length).toBeGreaterThan(0);
        const filePaths = fileElements.map((e) => e.filePath);
        expect(filePaths).toContain("src/routing/router.ts");
        expect(filePaths).toContain("src/routing/chain.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should skip auto-detection when contextFiles is provided", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        await Bun.spawn(["git", "init"], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: tempDir }).exited;

        await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "src/explicit.ts"), "export const explicit = true;");
        await fs.writeFile(path.join(tempDir, "src/routing.ts"), "export const routing = true;");

        await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing bug",
            description: "Fix routing",
            acceptanceCriteria: ["Works"],
            contextFiles: ["src/explicit.ts"], // Explicit file provided
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              fileInjection: "keyword",
              autoDetect: {
                enabled: true,
                maxFiles: 5,
                traceImports: false,
              },
              testCoverage: {
                enabled: false,
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
        const fileElements = built.elements.filter((e) => e.type === "file");

        // Should only load explicit file, NOT auto-detect
        expect(fileElements.length).toBe(1);
        expect(fileElements[0].filePath).toBe("src/explicit.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should skip auto-detection when disabled in config", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        await Bun.spawn(["git", "init"], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: tempDir }).exited;

        await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "src/routing.ts"), "export const routing = true;");

        await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing bug",
            description: "Fix routing",
            acceptanceCriteria: ["Works"],
            // No contextFiles
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              autoDetect: {
                enabled: false, // Disabled
                maxFiles: 5,
                traceImports: false,
              },
              testCoverage: {
                enabled: false,
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
        const fileElements = built.elements.filter((e) => e.type === "file");

        // Should NOT auto-detect when disabled
        expect(fileElements.length).toBe(0);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should handle auto-detection failure gracefully", async () => {
      // Non-git directory - git grep will fail
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "src/file.ts"), "export const test = true;");

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix test bug",
            description: "Fix test",
            acceptanceCriteria: ["Works"],
            // No contextFiles
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              autoDetect: {
                enabled: true,
                maxFiles: 5,
                traceImports: false,
              },
              testCoverage: {
                enabled: false,
              },
            },
          } as any,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        // Should not throw, just log warning and continue
        const built = await buildContext(storyContext, budget);
        const fileElements = built.elements.filter((e) => e.type === "file");

        // No files loaded (graceful failure)
        expect(fileElements.length).toBe(0);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
