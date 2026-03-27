/**
 * Unit tests for acceptance.ts — US-002 per-package runner.
 *
 * Tests the per-package acceptance runner that uses ctx.acceptanceTestPaths
 * and the backward-compatible fallback for pre-ACC-002 runs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { acceptanceStage } from "../../../../src/pipeline/stages/acceptance";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: "passed" | "pending" = "passed") {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria: ["AC-1: criterion"],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 0,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [makeStory("US-001", "passed")];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        testPath: "acceptance.test.ts",
      },
    } as any,
    effectiveConfig: undefined as any,
    prd: {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: stories,
    } as any,
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: {} as any,
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// US-002 AC-1: per-package test files run from their package directory
// ---------------------------------------------------------------------------

describe("US-002: per-package acceptance runner", () => {
  test("AC-1: runs each test file from its package directory when acceptanceTestPaths is set", async () => {
    const spawnCalls: Array<{ cwd: string; cmd: string[] }> = [];

    // Patch Bun.spawn for this test
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (cmd: string[], opts: any) => {
      spawnCalls.push({ cwd: opts.cwd, cmd });
      const mockProc = {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("1 pass\n"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      };
      return mockProc;
    };

    const ctx = makeCtx({
      acceptanceTestPaths: [
        { testPath: "/tmp/test-workdir/apps/api/.nax-acceptance.test.ts", packageDir: "/tmp/test-workdir/apps/api" },
        { testPath: "/tmp/test-workdir/apps/cli/.nax-acceptance.test.ts", packageDir: "/tmp/test-workdir/apps/cli" },
      ],
    });

    // Mock Bun.file().exists() to return true for test files
    const origFile = Bun.file;
    (Bun as any).file = (p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(""),
    });

    try {
      await acceptanceStage.execute(ctx);
      expect(spawnCalls.some((c) => c.cwd === "/tmp/test-workdir/apps/api")).toBe(true);
      expect(spawnCalls.some((c) => c.cwd === "/tmp/test-workdir/apps/cli")).toBe(true);
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).file = origFile;
    }
  });

  test("AC-3: falls back to single-file behavior when acceptanceTestPaths is not set", async () => {
    // When acceptanceTestPaths is absent, should use featureDir + testPath from config
    const ctx = makeCtx(); // no acceptanceTestPaths
    // File doesn't exist → stage continues without error (backward compat)
    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("continue");
  });

  test("AC-4: all packages passing returns continue", async () => {
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (_cmd: string[], _opts: any) => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1 pass\n"));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    });

    const origFile = Bun.file;
    (Bun as any).file = (_p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(""),
    });

    const ctx = makeCtx({
      acceptanceTestPaths: [
        { testPath: "/tmp/apps/api/.nax-acceptance.test.ts", packageDir: "/tmp/apps/api" },
        { testPath: "/tmp/apps/cli/.nax-acceptance.test.ts", packageDir: "/tmp/apps/cli" },
      ],
    });

    try {
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("continue");
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).file = origFile;
    }
  });
});

// ---------------------------------------------------------------------------
// Stage interface: enabled()
// ---------------------------------------------------------------------------

describe("acceptanceStage.enabled()", () => {
  test("enabled when acceptance is on and all stories complete", () => {
    const ctx = makeCtx();
    expect(acceptanceStage.enabled(ctx)).toBe(true);
  });

  test("disabled when not all stories complete", () => {
    const stories = [makeStory("US-001", "pending")];
    const ctx = makeCtx({
      prd: {
        project: "test",
        feature: "test",
        branchName: "feat/test",
        createdAt: "",
        updatedAt: "",
        userStories: stories,
      } as any,
      story: stories[0],
      stories,
    });
    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });

  test("disabled when acceptance.enabled is false", () => {
    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
      } as any,
    });
    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });
});
