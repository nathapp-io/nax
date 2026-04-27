// RE-ARCH: keep
/**
 * Integration tests for contextFiles/expectedFiles split
 * Verifies that context builder and verification use the correct resolvers
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { buildContext } from "../../../src/context/builder";
import type { ContextBudget, StoryContext } from "../../../src/context/types";
import { getContextFiles, getExpectedFiles } from "../../../src/prd";
import type { PRD, UserStory } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

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
    contextFiles: s.contextFiles,
    expectedFiles: s.expectedFiles,
    relevantFiles: s.relevantFiles,
  })),
});

describe("Context and Verification Integration", () => {
  test("story with contextFiles uses them for context injection", async () => {
    const tempDir = makeTempDir("nax-test-");

    try {
      // Create test files
      await fs.writeFile(path.join(tempDir, "src-file.ts"), 'export const src = "source";');
      await fs.writeFile(path.join(tempDir, "dist-file.js"), 'const dist = "output";');

      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Story with contextFiles",
          description: "Test",
          acceptanceCriteria: ["AC1"],
          contextFiles: ["src-file.ts"], // Only for context
          expectedFiles: ["dist-file.js"], // Only for verification
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

      // Context should include src-file.ts (from contextFiles)
      const fileElements = built.elements.filter((e) => e.type === "file");
      expect(fileElements.length).toBe(1);
      expect(fileElements[0].filePath).toBe("src-file.ts");
      expect(fileElements[0].content).toContain("src-file.ts");

      // Context should NOT include dist-file.js (only in expectedFiles)
      expect(fileElements.some((e) => e.filePath === "dist-file.js")).toBe(false);

      // Verification should use expectedFiles
      const story = prd.userStories[0];
      const filesToVerify = getExpectedFiles(story);
      expect(filesToVerify).toEqual(["dist-file.js"]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("story with relevantFiles uses them for context, not verification", async () => {
    const tempDir = makeTempDir("nax-test-");

    try {
      await fs.writeFile(path.join(tempDir, "legacy.ts"), 'export const legacy = "old";');

      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Legacy story",
          description: "Test",
          acceptanceCriteria: ["AC1"],
          relevantFiles: ["legacy.ts"], // Backward compat
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

      // Context should use relevantFiles as fallback
      const contextFiles = getContextFiles(prd.userStories[0]);
      expect(contextFiles).toEqual(["legacy.ts"]);

      const fileElements = built.elements.filter((e) => e.type === "file");
      expect(fileElements.length).toBe(1);
      expect(fileElements[0].filePath).toBe("legacy.ts");

      // Verification should NOT use relevantFiles (opt-in only)
      const filesToVerify = getExpectedFiles(prd.userStories[0]);
      expect(filesToVerify).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("story with no files specified should have empty context and verification", () => {
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Minimal story",
        description: "Test",
        acceptanceCriteria: ["AC1"],
      },
    ]);

    const story = prd.userStories[0];

    // Context should be empty
    const contextFiles = getContextFiles(story);
    expect(contextFiles).toEqual([]);

    // Verification should be empty
    const expectedFiles = getExpectedFiles(story);
    expect(expectedFiles).toEqual([]);
  });

  test("story with contextFiles but no expectedFiles should skip verification", async () => {
    const tempDir = makeTempDir("nax-test-");

    try {
      await fs.writeFile(path.join(tempDir, "helper.ts"), 'export const helper = "util";');

      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Refactor story",
          description: "Test",
          acceptanceCriteria: ["AC1"],
          contextFiles: ["helper.ts"], // For context only
          // No expectedFiles - just modifying existing code
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

      // Context should include helper.ts
      const fileElements = built.elements.filter((e) => e.type === "file");
      expect(fileElements.length).toBe(1);
      expect(fileElements[0].filePath).toBe("helper.ts");

      // Verification should be skipped (empty array)
      const filesToVerify = getExpectedFiles(prd.userStories[0]);
      expect(filesToVerify).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("story with both contextFiles and expectedFiles should use each correctly", async () => {
    const tempDir = makeTempDir("nax-test-");

    try {
      await fs.writeFile(path.join(tempDir, "input.ts"), 'export const input = "in";');
      await fs.writeFile(path.join(tempDir, "config.json"), '{"key": "value"}');
      await fs.writeFile(path.join(tempDir, "output.js"), 'const output = "out";');

      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Build story",
          description: "Test",
          acceptanceCriteria: ["AC1"],
          contextFiles: ["input.ts", "config.json"], // For context
          expectedFiles: ["output.js"], // For verification
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

      // Context should include input.ts and config.json
      const fileElements = built.elements.filter((e) => e.type === "file");
      expect(fileElements.length).toBe(2);
      expect(fileElements.some((e) => e.filePath === "input.ts")).toBe(true);
      expect(fileElements.some((e) => e.filePath === "config.json")).toBe(true);

      // Context should NOT include output.js (only in expectedFiles)
      expect(fileElements.some((e) => e.filePath === "output.js")).toBe(false);

      // Verification should only check output.js
      const filesToVerify = getExpectedFiles(prd.userStories[0]);
      expect(filesToVerify).toEqual(["output.js"]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("migration path: story with relevantFiles + new contextFiles should prefer contextFiles", async () => {
    const tempDir = makeTempDir("nax-test-");

    try {
      await fs.writeFile(path.join(tempDir, "new.ts"), 'export const newFile = "new";');
      await fs.writeFile(path.join(tempDir, "old.ts"), 'export const oldFile = "old";');

      const prd = createTestPRD([
        {
          id: "US-001",
          title: "Migrated story",
          description: "Test",
          acceptanceCriteria: ["AC1"],
          contextFiles: ["new.ts"], // New field
          relevantFiles: ["old.ts"], // Deprecated field (kept for backward compat)
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

      // Context should prefer contextFiles over relevantFiles
      const fileElements = built.elements.filter((e) => e.type === "file");
      expect(fileElements.length).toBe(1);
      expect(fileElements[0].filePath).toBe("new.ts");
      expect(fileElements[0].content).toContain("new.ts");

      // Old file should not be loaded
      expect(fileElements.some((e) => e.filePath === "old.ts")).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
