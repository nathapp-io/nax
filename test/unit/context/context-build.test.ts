// RE-ARCH: keep
/**
 * Tests for context builder module — buildContext and file loading
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { buildContext } from "../../../src/context";
import type { ContextBudget, StoryContext } from "../../../src/context/types";
import type { PRD, UserStory } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

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
  describe("buildContext", () => {
    test("should extract current story from PRD", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "First Story",
          description: "First description",
          acceptanceCriteria: ["AC1"],
        },
        {
          id: "US-002",
          title: "Second Story",
          description: "Second description",
          acceptanceCriteria: ["AC2"],
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

      // Should have progress + current story
      expect(built.elements.length).toBe(2);
      expect(built.elements.some((e) => e.type === "progress")).toBe(true);
      expect(built.elements.some((e) => e.type === "story" && e.storyId === "US-001")).toBe(true);
      expect(built.totalTokens).toBeLessThanOrEqual(9000);
    });

    test("should include dependency stories", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Dependency Story",
          description: "Dependency description",
          acceptanceCriteria: ["AC1"],
          status: "passed",
          passes: true,
        },
        {
          id: "US-002",
          title: "Current Story",
          description: "Current description",
          acceptanceCriteria: ["AC2"],
          dependencies: ["US-001"],
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

      // Should have progress + current story + dependency
      expect(built.elements.length).toBe(3);
      expect(built.elements.some((e) => e.type === "progress")).toBe(true);
      expect(built.elements.some((e) => e.type === "story" && e.storyId === "US-002")).toBe(true);
      expect(built.elements.some((e) => e.type === "dependency" && e.storyId === "US-001")).toBe(true);
    });

    test("should include prior errors", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Failed Story",
          description: "Story with errors",
          acceptanceCriteria: ["AC1"],
          priorErrors: ["Error 1", "Error 2"],
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

      const errorElements = built.elements.filter((e) => e.type === "error");
      expect(errorElements.length).toBe(2);
      expect(built.summary).toContain("2 errors");
    });

    test("should generate progress summary", async () => {
      const prd = createTestPRD([
        { id: "US-001", status: "passed", passes: true },
        { id: "US-002", status: "passed", passes: true },
        { id: "US-003", status: "failed", passes: false },
        { id: "US-004", status: "pending", passes: false },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-004",
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      const built = await buildContext(storyContext, budget);

      const progressElement = built.elements.find((e) => e.type === "progress");
      expect(progressElement).toBeDefined();
      expect(progressElement?.content).toContain("3/4 stories complete");
      expect(progressElement?.content).toContain("2 passed");
      expect(progressElement?.content).toContain("1 failed");
    });

    test("should truncate when exceeding budget", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Story with many dependencies",
          description: "x".repeat(1000),
          acceptanceCriteria: ["AC1"],
          dependencies: ["US-002", "US-003", "US-004", "US-005"],
        },
        { id: "US-002", description: "x".repeat(1000), acceptanceCriteria: ["AC2"] },
        { id: "US-003", description: "x".repeat(1000), acceptanceCriteria: ["AC3"] },
        { id: "US-004", description: "x".repeat(1000), acceptanceCriteria: ["AC4"] },
        { id: "US-005", description: "x".repeat(1000), acceptanceCriteria: ["AC5"] },
      ]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-001",
      };

      const budget: ContextBudget = {
        maxTokens: 1000,
        reservedForInstructions: 500,
        availableForContext: 500, // Small budget
      };

      const built = await buildContext(storyContext, budget);

      expect(built.truncated).toBe(true);
      expect(built.totalTokens).toBeLessThanOrEqual(500);
      expect(built.summary).toContain("[TRUNCATED]");
      // Progress should always be included (highest priority)
      expect(built.elements.some((e) => e.type === "progress")).toBe(true);
    });

    test("should throw error for non-existent story", async () => {
      const prd = createTestPRD([{ id: "US-001", title: "Story" }]);

      const storyContext: StoryContext = {
        prd,
        currentStoryId: "US-999", // Non-existent
      };

      const budget: ContextBudget = {
        maxTokens: 10000,
        reservedForInstructions: 1000,
        availableForContext: 9000,
      };

      await expect(buildContext(storyContext, budget)).rejects.toThrow("Story US-999 not found in PRD");
    });

    test("should load files from contextFiles when present", async () => {
      const tempDir = makeTempDir("nax-test-");
      const testFile1 = path.join(tempDir, "helper.ts");
      const testFile2 = path.join(tempDir, "utils.ts");

      await fs.writeFile(testFile1, 'export function helper() { return "test"; }');
      await fs.writeFile(testFile2, 'export function utils() { return "util"; }');

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Story with Files",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            contextFiles: ["helper.ts", "utils.ts"],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: { context: { fileInjection: "keyword", testCoverage: { enabled: false } } } as any,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);

        const fileElements = built.elements.filter((e) => e.type === "file");
        expect(fileElements.length).toBe(2);
        expect(fileElements[0].filePath).toBe("helper.ts");
        expect(fileElements[1].filePath).toBe("utils.ts");
        expect(fileElements[0].content).toContain("helper.ts");
        expect(fileElements[1].content).toContain("utils.ts");
        expect(built.summary).toContain("2 files");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should fall back to relevantFiles for file loading when contextFiles not present", async () => {
      const tempDir = makeTempDir("nax-test-");
      const testFile = path.join(tempDir, "legacy.ts");

      await fs.writeFile(testFile, 'export function legacy() { return "old"; }');

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Legacy Story with relevantFiles",
            description: "Test backward compatibility",
            acceptanceCriteria: ["AC1"],
            relevantFiles: ["legacy.ts"],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: { context: { fileInjection: "keyword", testCoverage: { enabled: false } } } as any,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);

        const fileElements = built.elements.filter((e) => e.type === "file");
        expect(fileElements.length).toBe(1);
        expect(fileElements[0].filePath).toBe("legacy.ts");
        expect(fileElements[0].content).toContain("legacy.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should prefer contextFiles over relevantFiles for file loading", async () => {
      const tempDir = makeTempDir("nax-test-");
      const newFile = path.join(tempDir, "new.ts");
      const oldFile = path.join(tempDir, "old.ts");

      await fs.writeFile(newFile, "export function newFunc() {}");
      await fs.writeFile(oldFile, "export function oldFunc() {}");

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Story with both contextFiles and relevantFiles",
            description: "Test precedence",
            acceptanceCriteria: ["AC1"],
            contextFiles: ["new.ts"],
            relevantFiles: ["old.ts"],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: { context: { fileInjection: "keyword", testCoverage: { enabled: false } } } as any,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);

        const fileElements = built.elements.filter((e) => e.type === "file");
        expect(fileElements.length).toBe(1);
        expect(fileElements[0].filePath).toBe("new.ts");
        expect(fileElements[0].content).toContain("new.ts");
        expect(fileElements.find((e) => e.filePath === "old.ts")).toBeUndefined();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should respect max 5 files limit", async () => {
      const tempDir = makeTempDir("nax-test-");

      try {
        const files: string[] = [];
        for (let i = 0; i < 10; i++) {
          const filename = `file${i}.ts`;
          files.push(filename);
          await fs.writeFile(path.join(tempDir, filename), `export const file${i} = ${i};`);
        }

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Story with Many Files",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            contextFiles: files,
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: { context: { fileInjection: "keyword", testCoverage: { enabled: false } } } as any,
        };

        const budget: ContextBudget = {
          maxTokens: 10000,
          reservedForInstructions: 1000,
          availableForContext: 9000,
        };

        const built = await buildContext(storyContext, budget);

        const fileElements = built.elements.filter((e) => e.type === "file");
        expect(fileElements.length).toBe(5); // Max 5 files
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should add path-only element for files larger than 10KB", async () => {
      const tempDir = makeTempDir("nax-test-");

      try {
        const smallFile = path.join(tempDir, "small.ts");
        const largeFile = path.join(tempDir, "large.ts");

        await fs.writeFile(smallFile, 'export const small = "ok";');
        await fs.writeFile(largeFile, "x".repeat(11 * 1024)); // 11KB

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Story with Large File",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            contextFiles: ["small.ts", "large.ts"],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: { context: { fileInjection: "keyword", testCoverage: { enabled: false } } } as any,
        };

        const budget: ContextBudget = {
          maxTokens: 20000,
          reservedForInstructions: 1000,
          availableForContext: 19000,
        };

        const originalWarn = console.warn;
        const warnings: string[] = [];
        console.warn = (msg: string) => warnings.push(msg);

        const built = await buildContext(storyContext, budget);

        console.warn = originalWarn;

        const fileElements = built.elements.filter((e) => e.type === "file");
        expect(fileElements.length).toBe(2); // both emitted as path-only references
        expect(fileElements[0].filePath).toBe("small.ts");
        const largeElement = fileElements.find((e) => e.filePath === "large.ts");
        expect(largeElement).toBeDefined();
        expect(largeElement?.content).toContain("large.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should warn on missing files", async () => {
      const tempDir = makeTempDir("nax-test-");

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Story with Missing File",
            description: "Test",
            acceptanceCriteria: ["AC1"],
            contextFiles: ["nonexistent.ts"],
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

        const fileElements = built.elements.filter((e) => e.type === "file");
        expect(fileElements.length).toBe(0);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should handle empty contextFiles array", async () => {
      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Story with Empty Files",
          description: "Test",
          acceptanceCriteria: ["AC1"],
          contextFiles: [],
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

      const fileElements = built.elements.filter((e) => e.type === "file");
      expect(fileElements.length).toBe(0);
    });

    test("should respect token budget when loading files", async () => {
      const tempDir = makeTempDir("nax-test-");

      try {
        await fs.writeFile(path.join(tempDir, "file1.ts"), "x".repeat(5000));
        await fs.writeFile(path.join(tempDir, "file2.ts"), "x".repeat(5000));

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Story",
            description: "x".repeat(1000),
            acceptanceCriteria: ["AC1"],
            contextFiles: ["file1.ts", "file2.ts"],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
        };

        const budget: ContextBudget = {
          maxTokens: 2000,
          reservedForInstructions: 500,
          availableForContext: 1500, // Small budget
        };

        const built = await buildContext(storyContext, budget);

        expect(built.totalTokens).toBeLessThanOrEqual(1500);
        // Files have lower priority (60) than story (80), so story should be included
        expect(built.elements.some((e) => e.type === "story")).toBe(true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
