// RE-ARCH: keep
/**
 * Tests for context builder module — isolation, test coverage scoping, and analysis injection
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { buildContext, formatContextAsMarkdown } from "../../../src/context";
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
  describe("test coverage scoping", () => {
    test("should scope test coverage to story contextFiles", async () => {
      const tempDir = makeTempDir("nax-test-");

      try {
        const testDir = path.join(tempDir, "test");
        await fs.mkdir(testDir);

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
                scopeToStory: true,
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

        expect(built.elements.some((e) => e.type === "test-coverage")).toBe(true);
        expect(markdown).toContain("health.service.test.ts");
        expect(markdown).not.toContain("auth.service.test.ts");
        expect(markdown).not.toContain("db.connection.test.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should scan all tests when scopeToStory=false", async () => {
      const tempDir = makeTempDir("nax-test-");

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

        expect(markdown).toContain("health.test.ts");
        expect(markdown).toContain("auth.test.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should fall back to full scan when no contextFiles provided", async () => {
      const tempDir = makeTempDir("nax-test-");

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

      expect(markdown).toContain("US-003");
      expect(markdown).toContain("Add HTTP indicator");
      expect(markdown).toContain("US-001");
      expect(markdown).toContain("Define core interfaces");
      expect(markdown).not.toContain("US-002");
      expect(markdown).not.toContain("Implement health service");
      expect(markdown).not.toContain("US-004");
      expect(markdown).not.toContain("Add database indicator");
      expect(markdown).not.toContain("US-005");
      expect(markdown).not.toContain("REST endpoint");
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
      expect(progressElement?.content).toContain("2/3");
      expect(progressElement?.content).not.toContain("Secret Story Alpha");
      expect(progressElement?.content).not.toContain("Secret Story Beta");
      expect(progressElement?.content).not.toContain("US-001");
      expect(progressElement?.content).not.toContain("US-002");
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

      const types = built.elements.map((e) => e.type);
      expect(types).toContain("progress");
      expect(types).toContain("story");
      expect(types).not.toContain("dependency");
      expect(types).not.toContain("error");

      const storyElements = built.elements.filter((e) => e.storyId);
      for (const el of storyElements) {
        expect(el.storyId).toBe("US-001");
      }
    });
  });

  // BUG-006
  describe("context auto-detection when contextFiles is empty", () => {
    test("should auto-detect files when contextFiles is empty", async () => {
      const tempDir = makeTempDir("nax-test-");

      try {
        await Bun.spawn(["git", "init"], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: tempDir }).exited;

        await fs.mkdir(path.join(tempDir, "src/routing"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "src/routing/router.ts"), "export class Router { /* routing logic */ }");
        await fs.writeFile(
          path.join(tempDir, "src/routing/chain.ts"),
          "export class RouterChain { /* chain logic */ }",
        );

        await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
        await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing chain bug",
            description: "Fix issue in router chain",
            acceptanceCriteria: ["Router chain works correctly"],
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

        expect(fileElements.length).toBeGreaterThan(0);
        const filePaths = fileElements.map((e) => e.filePath);
        expect(filePaths).toContain("src/routing/router.ts");
        expect(filePaths).toContain("src/routing/chain.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should skip auto-detection when contextFiles is provided", async () => {
      const tempDir = makeTempDir("nax-test-");

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

        expect(fileElements.length).toBe(1);
        expect(fileElements[0].filePath).toBe("src/explicit.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should skip auto-detection when disabled in config", async () => {
      const tempDir = makeTempDir("nax-test-");

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

        expect(fileElements.length).toBe(0);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should handle auto-detection failure gracefully", async () => {
      const tempDir = makeTempDir("nax-test-");

      try {
        await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "src/file.ts"), "export const test = true;");

        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix test bug",
            description: "Fix test",
            acceptanceCriteria: ["Works"],
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

        expect(fileElements.length).toBe(0);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ENH-006: prd.analysis injection
  // ──────────────────────────────────────────────────────────────────────────

  describe("prd.analysis injection (ENH-006)", () => {
    const budget: ContextBudget = {
      maxTokens: 10000,
      reservedForInstructions: 1000,
      availableForContext: 9000,
    };

    test("injects planning-analysis element when prd.analysis is set", async () => {
      const prd: PRD = {
        ...createTestPRD([{ id: "US-001" }]),
        analysis: "Current auth uses @nestjs/jwt. Key files: src/auth/auth.module.ts",
      };
      const context: StoryContext = { prd, currentStoryId: "US-001" };

      const built = await buildContext(context, budget);
      const analysisEl = built.elements.find((e) => e.type === "planning-analysis");

      expect(analysisEl).toBeDefined();
      expect(analysisEl?.content).toContain("Current auth uses @nestjs/jwt");
      expect(analysisEl?.label).toBe("Planning Analysis");
    });

    test("no planning-analysis element when prd.analysis is not set", async () => {
      const prd = createTestPRD([{ id: "US-001" }]);
      const context: StoryContext = { prd, currentStoryId: "US-001" };

      const built = await buildContext(context, budget);
      const analysisEl = built.elements.find((e) => e.type === "planning-analysis");

      expect(analysisEl).toBeUndefined();
    });

    test("planning-analysis has priority 88 (between errors:90 and story:80)", async () => {
      const prd: PRD = {
        ...createTestPRD([{ id: "US-001" }]),
        analysis: "Some analysis",
      };
      const context: StoryContext = { prd, currentStoryId: "US-001" };

      const built = await buildContext(context, budget);
      const analysisEl = built.elements.find((e) => e.type === "planning-analysis");

      expect(analysisEl?.priority).toBe(88);
    });
  });
});
