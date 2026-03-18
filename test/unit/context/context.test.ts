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
      expect(progressElement!.content).toContain("3/4 stories complete");
      expect(progressElement!.content).toContain("2 passed");
      expect(progressElement!.content).toContain("1 failed");
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
      // Create temp directory and files
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));
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
        expect(fileElements[0].content).toContain("helper()");
        expect(fileElements[1].content).toContain("utils()");
        expect(built.summary).toContain("2 files");
      } finally {
        // Cleanup
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should fall back to relevantFiles for file loading when contextFiles not present", async () => {
      // Create temp directory and files
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));
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
        expect(fileElements[0].content).toContain("legacy()");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should prefer contextFiles over relevantFiles for file loading", async () => {
      // Create temp directory and files
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));
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
        expect(fileElements[0].content).toContain("newFunc()");
        // Should NOT load old.ts
        expect(fileElements.find((e) => e.filePath === "old.ts")).toBeUndefined();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should respect max 5 files limit", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        // Create 10 test files
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
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

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

        // Capture warnings
        const originalWarn = console.warn;
        const warnings: string[] = [];
        console.warn = (msg: string) => warnings.push(msg);

        const built = await buildContext(storyContext, budget);

        console.warn = originalWarn;

        const fileElements = built.elements.filter((e) => e.type === "file");
        expect(fileElements.length).toBe(2); // small file (inline) + large file (path-only)
        expect(fileElements[0].filePath).toBe("small.ts");
        // Large file gets path-only hint (FEAT-011)
        const largeElement = fileElements.find((e) => e.filePath === "large.ts");
        expect(largeElement).toBeDefined();
        expect(largeElement!.content).toContain("File too large to inline");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should warn on missing files", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

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
        // Missing file should be skipped (warning logged via structured logger)
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
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-test-"));

      try {
        // Create files with substantial content
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
          config: { context: { fileInjection: "keyword", testCoverage: { enabled: false } } } as any,
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

  // BUG-006
  describe("context auto-detection when contextFiles is empty", () => {
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
