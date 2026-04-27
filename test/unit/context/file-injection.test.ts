/**
 * Tests for context.fileInjection config flag (CTX-001)
 *
 * Verifies that:
 * - Explicit contextFiles from the PRD are ALWAYS honored (path-only) regardless of fileInjection
 * - fileInjection: 'disabled' only skips auto-detection; explicit contextFiles still appear
 * - fileInjection: 'keyword' enables auto-detect when no explicit files are provided
 * - missing fileInjection (undefined) disables auto-detect; explicit contextFiles still honored
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
// NOTE: _contextBuilderDeps is exported from builder.ts — mock-based tests below
// use this injection pattern for testing
import { _contextBuilderDeps, buildContext } from "../../../src/context/builder";
import type { ContextBudget, StoryContext } from "../../../src/context/types";
import type { PRD, UserStory } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

// Helper to create a minimal test PRD
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

/** Standard token budget for all tests */
const BUDGET: ContextBudget = {
  maxTokens: 10000,
  reservedForInstructions: 1000,
  availableForContext: 9000,
};

/** Set up a temp git repo with a src file, returns tempDir */
async function setupGitRepo(srcFiles: Record<string, string>): Promise<string> {
  const tempDir = makeTempDir("nax-test-injection-");
  await Bun.spawn(["git", "init"], { cwd: tempDir }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: tempDir }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: tempDir }).exited;

  for (const [relPath, content] of Object.entries(srcFiles)) {
    const absPath = path.join(tempDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
  }

  await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
  await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;
  return tempDir;
}

describe("context.fileInjection config flag (CTX-001)", () => {
  describe("fileInjection: 'disabled'", () => {
    test("no file elements added when fileInjection is disabled and no contextFiles", async () => {
      const tempDir = await setupGitRepo({
        "src/routing/router.ts": "export class Router { /* routing logic */ }",
      });

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing chain bug",
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
              fileInjection: "disabled",
              autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
              testCoverage: { enabled: false },
            },
          } as any,
        };

        const built = await buildContext(storyContext, BUDGET);
        const fileElements = built.elements.filter((e) => e.type === "file");

        // disabled => no file elements, even though auto-detect would normally find files
        expect(fileElements.length).toBe(0);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("explicit contextFiles are honored even when fileInjection is disabled", async () => {
      const tempDir = await setupGitRepo({
        "src/routing/router.ts": "export class Router { /* routing logic */ }",
      });

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing chain bug",
            description: "Fix routing",
            acceptanceCriteria: ["Works"],
            contextFiles: ["src/routing/router.ts"], // Explicit file provided
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              fileInjection: "disabled",
              autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
              testCoverage: { enabled: false },
            },
          } as any,
        };

        const built = await buildContext(storyContext, BUDGET);
        const fileElements = built.elements.filter((e) => e.type === "file");

        // disabled only blocks auto-detect; explicit contextFiles are always honored
        expect(fileElements.length).toBe(1);
        expect(fileElements[0].filePath).toBe("src/routing/router.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("fileInjection: undefined (missing)", () => {
    test("treated as disabled — no file elements added when fileInjection is undefined", async () => {
      const tempDir = await setupGitRepo({
        "src/routing/router.ts": "export class Router { /* routing logic */ }",
      });

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing chain bug",
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
              // fileInjection intentionally omitted (undefined)
              autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
              testCoverage: { enabled: false },
            },
          } as any,
        };

        const built = await buildContext(storyContext, BUDGET);
        const fileElements = built.elements.filter((e) => e.type === "file");

        // undefined => treated as disabled => no file elements
        expect(fileElements.length).toBe(0);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("explicit contextFiles are honored even when fileInjection is undefined", async () => {
      const tempDir = await setupGitRepo({
        "src/explicit.ts": "export const explicit = true;",
      });

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing chain bug",
            description: "Fix routing",
            acceptanceCriteria: ["Works"],
            contextFiles: ["src/explicit.ts"],
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              // fileInjection intentionally omitted (undefined)
              autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
              testCoverage: { enabled: false },
            },
          } as any,
        };

        const built = await buildContext(storyContext, BUDGET);
        const fileElements = built.elements.filter((e) => e.type === "file");

        // undefined disables auto-detect but explicit contextFiles are always honored
        expect(fileElements.length).toBe(1);
        expect(fileElements[0].filePath).toBe("src/explicit.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("fileInjection: 'keyword'", () => {
    test("auto-detect runs and injects files when fileInjection is keyword", async () => {
      const tempDir = await setupGitRepo({
        "src/routing/router.ts": "export class Router { /* routing logic */ }",
        "src/routing/chain.ts": "export class RouterChain { /* chain logic */ }",
      });

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing chain bug",
            description: "Fix routing",
            acceptanceCriteria: ["Works"],
            // No explicit contextFiles — auto-detect should kick in
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              fileInjection: "keyword",
              autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
              testCoverage: { enabled: false },
            },
          } as any,
        };

        const built = await buildContext(storyContext, BUDGET);
        const fileElements = built.elements.filter((e) => e.type === "file");

        // keyword => auto-detect runs => file elements present
        expect(fileElements.length).toBeGreaterThan(0);
        const filePaths = fileElements.map((e) => e.filePath);
        expect(filePaths).toContain("src/routing/router.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("explicit contextFiles are injected when fileInjection is keyword", async () => {
      const tempDir = await setupGitRepo({
        "src/explicit.ts": "export const explicit = true;",
        "src/other.ts": "export const other = true;",
      });

      try {
        const prd = createTestPRD([
          {
            id: "US-001",
            title: "Fix routing bug",
            description: "Fix routing",
            acceptanceCriteria: ["Works"],
            contextFiles: ["src/explicit.ts"], // Explicit file
          },
        ]);

        const storyContext: StoryContext = {
          prd,
          currentStoryId: "US-001",
          workdir: tempDir,
          config: {
            context: {
              fileInjection: "keyword",
              autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
              testCoverage: { enabled: false },
            },
          } as any,
        };

        const built = await buildContext(storyContext, BUDGET);
        const fileElements = built.elements.filter((e) => e.type === "file");

        // keyword with explicit contextFiles => file elements present
        expect(fileElements.length).toBeGreaterThan(0);
        const filePaths = fileElements.map((e) => e.filePath);
        expect(filePaths).toContain("src/explicit.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("explicit contextFiles still injected when autoDetect.enabled is false", async () => {
      const tempDir = await setupGitRepo({
        "src/explicit.ts": "export const explicit = true;",
      });

      try {
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
              autoDetect: { enabled: false, maxFiles: 5, traceImports: false }, // auto-detect off
              testCoverage: { enabled: false },
            },
          } as any,
        };

        const built = await buildContext(storyContext, BUDGET);
        const fileElements = built.elements.filter((e) => e.type === "file");

        // keyword + autoDetect disabled => explicit contextFiles still injected
        expect(fileElements.length).toBe(1);
        expect(fileElements[0].filePath).toBe("src/explicit.ts");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Mock-based tests using _contextBuilderDeps injection
//
// These tests verify call/no-call of autoDetectContextFiles without spawning
// real git processes. They require _contextBuilderDeps to be exported from builder.ts.
// ---------------------------------------------------------------------------

describe("fileInjection modes — mock-based (CTX-003)", () => {
  let originalAutoDetect: typeof _contextBuilderDeps.autoDetectContextFiles;
  let tempDir: string;

  beforeEach(async () => {
    originalAutoDetect = _contextBuilderDeps.autoDetectContextFiles;
    tempDir = makeTempDir("nax-fi-mock-test-");
  });

  afterEach(async () => {
    mock.restore();
    _contextBuilderDeps.autoDetectContextFiles = originalAutoDetect;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("fileInjection 'disabled' — autoDetectContextFiles is never called", async () => {
    const spy = mock(async () => ["src/some-file.ts"]);
    _contextBuilderDeps.autoDetectContextFiles = spy;

    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Fix routing chain bug",
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
          fileInjection: "disabled",
          autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
          testCoverage: { enabled: false },
        },
      } as any,
    };

    const built = await buildContext(storyContext, BUDGET);

    expect(spy).not.toHaveBeenCalled();
    expect(built.elements.filter((e) => e.type === "file").length).toBe(0);
  });

  test("fileInjection 'keyword' with no contextFiles — autoDetectContextFiles is called", async () => {
    await fs.writeFile(path.join(tempDir, "context-builder.ts"), 'export const x = "injected";');
    const spy = mock(async () => ["context-builder.ts"]);
    _contextBuilderDeps.autoDetectContextFiles = spy;

    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Fix context builder logic",
        description: "Fix builder",
        acceptanceCriteria: ["Works"],
        // No contextFiles → auto-detect should run
      },
    ]);

    const storyContext: StoryContext = {
      prd,
      currentStoryId: "US-001",
      workdir: tempDir,
      config: {
        context: {
          fileInjection: "keyword",
          autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
          testCoverage: { enabled: false },
        },
      } as any,
    };

    const built = await buildContext(storyContext, BUDGET);
    const fileElements = built.elements.filter((e) => e.type === "file");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(fileElements.length).toBe(1);
    expect(fileElements[0].filePath).toBe("context-builder.ts");
  });

  test("fileInjection 'keyword' + autoDetect.enabled false — autoDetectContextFiles not called, explicit files injected", async () => {
    await fs.writeFile(path.join(tempDir, "explicit.ts"), "export const explicit = true;");
    const spy = mock(async () => ["src/should-not-appear.ts"]);
    _contextBuilderDeps.autoDetectContextFiles = spy;

    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Fix explicit injection",
        description: "Fix injection",
        acceptanceCriteria: ["Works"],
        contextFiles: ["explicit.ts"],
      },
    ]);

    const storyContext: StoryContext = {
      prd,
      currentStoryId: "US-001",
      workdir: tempDir,
      config: {
        context: {
          fileInjection: "keyword",
          autoDetect: { enabled: false, maxFiles: 5, traceImports: false },
          testCoverage: { enabled: false },
        },
      } as any,
    };

    const built = await buildContext(storyContext, BUDGET);
    const fileElements = built.elements.filter((e) => e.type === "file");

    expect(spy).not.toHaveBeenCalled();
    expect(fileElements.length).toBe(1);
    expect(fileElements[0].filePath).toBe("explicit.ts");
  });

  test("fileInjection undefined — autoDetectContextFiles is never called, explicit contextFiles still honored", async () => {
    await fs.writeFile(path.join(tempDir, "some-file.ts"), "export const x = 1;");
    const spy = mock(async () => ["src/some-file.ts"]);
    _contextBuilderDeps.autoDetectContextFiles = spy;

    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Some story",
        description: "Some description",
        acceptanceCriteria: ["Works"],
        contextFiles: ["some-file.ts"],
      },
    ]);

    const storyContext: StoryContext = {
      prd,
      currentStoryId: "US-001",
      workdir: tempDir,
      config: {
        context: {
          // fileInjection intentionally omitted
          testCoverage: { enabled: false },
        },
      } as any,
    };

    const built = await buildContext(storyContext, BUDGET);

    // auto-detect skipped, but explicit contextFiles are always honored
    expect(spy).not.toHaveBeenCalled();
    expect(built.elements.filter((e) => e.type === "file").length).toBe(1);
  });

  test("fileInjection 'disabled' with explicit contextFiles — autoDetectContextFiles not called, explicit files still honored", async () => {
    await fs.writeFile(path.join(tempDir, "explicit.ts"), "export const x = 1;");
    const spy = mock(async () => []);
    _contextBuilderDeps.autoDetectContextFiles = spy;

    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Story with explicit contextFiles",
        description: "Some story",
        acceptanceCriteria: ["Works"],
        contextFiles: ["explicit.ts"],
      },
    ]);

    const storyContext: StoryContext = {
      prd,
      currentStoryId: "US-001",
      workdir: tempDir,
      config: {
        context: {
          fileInjection: "disabled",
          testCoverage: { enabled: false },
        },
      } as any,
    };

    const built = await buildContext(storyContext, BUDGET);
    const fileElements = built.elements.filter((e) => e.type === "file");

    // disabled only blocks auto-detect; explicit contextFiles are always honored
    expect(spy).not.toHaveBeenCalled();
    expect(fileElements.length).toBe(1);
    expect(fileElements[0].filePath).toBe("explicit.ts");
  });
});
