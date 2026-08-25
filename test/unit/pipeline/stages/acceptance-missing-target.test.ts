/**
 * Unit tests for US-003: fail acceptance when a required target is missing.
 *
 * Covers AC-1 through AC-9 of the story spec — the consumer-side predicate that
 * turns a missing acceptance test file into a hard fail when the group has PRD
 * stories and acceptance is enabled for the package.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeDispatchContext, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { addSink, initLogger, resetLogger } from "@/logger";
import { acceptanceStage } from "@/pipeline/stages";
import type { PipelineContext } from "@/pipeline/types";
import { _executorDeps } from "@/verification";

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helpers (mirrored from acceptance.test.ts so the US-003 suite is self-contained)
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [
    makeStory({
      id: "US-001",
      status: "passed",
      passes: true,
      attempts: 0,
      acceptanceCriteria: ["AC-1: criterion"],
    }),
  ];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        testPath: "acceptance.test.ts",
      },
    } as any,
    rootConfig: DEFAULT_CONFIG,
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
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: {} as any,
    ...makeDispatchContext(),
    ...overrides,
  };
}

/**
 * Mocks Bun.file().exists() to return true only for the listed absolute paths,
 * false for everything else — used to trigger the missing-target predicate.
 */
function stubFileExists(presentPaths: Set<string>): () => void {
  const origFile = Bun.file;
  (Bun as any).file = (p: string) => ({
    exists: () => Promise.resolve(presentPaths.has(p)),
    text: () => Promise.resolve(""),
  });
  return () => {
    (Bun as any).file = origFile;
  };
}

// ---------------------------------------------------------------------------
// US-003: Missing acceptance target fails the run
// ---------------------------------------------------------------------------

describe("US-003: missing acceptance target fails the run", () => {
  test("AC-1: missing target with storyCount=1 + acceptanceEnabled=true → fail", async () => {
    const restoreFile = stubFileExists(new Set());
    try {
      const ctx = makeCtx({
        acceptanceTestPaths: [
          {
            testPath: "/missing/target.test.ts",
            packageDir: "/missing",
            storyCount: 1,
            acceptanceEnabled: true,
          },
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("fail");
    } finally {
      restoreFile();
    }
  });

  test("AC-2: multiple missing targets → reason names every affected packageDir", async () => {
    const restoreFile = stubFileExists(new Set());
    try {
      const ctx = makeCtx({
        acceptanceTestPaths: [
          {
            testPath: "/missing/a.test.ts",
            packageDir: "/packages/a",
            storyCount: 1,
            acceptanceEnabled: true,
          },
          {
            testPath: "/missing/b.test.ts",
            packageDir: "/packages/b",
            storyCount: 2,
            acceptanceEnabled: true,
          },
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("fail");
      if (result.action === "fail") {
        expect(result.reason).toContain("/packages/a");
        expect(result.reason).toContain("/packages/b");
      }
    } finally {
      restoreFile();
    }
  });

  test("AC-3: missing target with storyCount=0 → continue", async () => {
    const restoreFile = stubFileExists(new Set());
    try {
      const ctx = makeCtx({
        acceptanceTestPaths: [
          {
            testPath: "/missing/empty.test.ts",
            packageDir: "/empty",
            storyCount: 0,
            acceptanceEnabled: true,
          },
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("continue");
    } finally {
      restoreFile();
    }
  });

  test("AC-4: missing target with acceptanceEnabled=false → continue", async () => {
    const restoreFile = stubFileExists(new Set());
    try {
      const ctx = makeCtx({
        acceptanceTestPaths: [
          {
            testPath: "/missing/disabled.test.ts",
            packageDir: "/disabled",
            storyCount: 1,
            acceptanceEnabled: false,
          },
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("continue");
    } finally {
      restoreFile();
    }
  });

  test("AC-5: missing target with storyCount undefined + non-fix PRD story in same package → fail", async () => {
    const restoreFile = stubFileExists(new Set());
    try {
      const pkgDir = "/tmp/test-workdir/packages/api";
      const story = makeStory({
        id: "US-100",
        status: "passed",
        passes: true,
        attempts: 0,
        workdir: "packages/api",
        acceptanceCriteria: ["AC-1: criterion"],
      });
      const ctx = makeCtx({
        workdir: "/tmp/test-workdir",
        prd: {
          project: "test-project",
          feature: "test-feature",
          branchName: "feat/test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userStories: [story],
        } as any,
        story,
        stories: [story],
        acceptanceTestPaths: [
          {
            testPath: `${pkgDir}/.nax-acceptance.test.ts`,
            packageDir: pkgDir,
            // storyCount omitted — consumer must derive it from PRD
          },
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("fail");
    } finally {
      restoreFile();
    }
  });

  test("AC-6: missing target with acceptanceEnabled undefined → fail (treated as enabled)", async () => {
    const restoreFile = stubFileExists(new Set());
    try {
      const ctx = makeCtx({
        acceptanceTestPaths: [
          {
            testPath: "/missing/default.test.ts",
            packageDir: "/default",
            storyCount: 1,
            // acceptanceEnabled omitted — consumer defaults to true
          },
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("fail");
    } finally {
      restoreFile();
    }
  });

  test("AC-7: missing-target failure record contributes no entries to failedACs", async () => {
    const restoreFile = stubFileExists(new Set());
    try {
      const ctx = makeCtx({
        acceptanceTestPaths: [
          {
            testPath: "/missing/target.test.ts",
            packageDir: "/missing",
            storyCount: 1,
            acceptanceEnabled: true,
          },
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("fail");
      expect(ctx.acceptanceFailures?.failedACs ?? []).toEqual([]);
    } finally {
      restoreFile();
    }
  });

  test("AC-8: config.acceptance.enabled=false → enabled() returns false", () => {
    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
      } as any,
    });
    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });

  test("AC-9: every group present and passing → continue", async () => {
    const present = new Set(["/tmp/a.test.ts", "/tmp/b.test.ts"]);
    const restoreFile = stubFileExists(present);
    const origSpawn = _executorDeps.spawn;
    _executorDeps.spawn = ((_cmd: string[], _opts: any) => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("1 pass\n"));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    })) as unknown as typeof _executorDeps.spawn; // test-ratchet-allow: as-unknown-as
    try {
      const ctx = makeCtx({
        acceptanceTestPaths: [
          { testPath: "/tmp/a.test.ts", packageDir: "/a", storyCount: 1, acceptanceEnabled: true },
          { testPath: "/tmp/b.test.ts", packageDir: "/b", storyCount: 1, acceptanceEnabled: true },
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("continue");
    } finally {
      _executorDeps.spawn = origSpawn;
      restoreFile();
    }
  });

  test("mixed: missing target + another package's AC failures → preserves the AC failures", async () => {
    // Package /missing has a missing target → recorded via missingTargets (AC-7 says
    // no entries in failedACs for this package).
    // Package /present has a present test file with a real AC failure that must be
    // preserved in failedACs alongside the missing-target signal.
    const present = new Set(["/tmp/present.test.ts"]);
    const restoreFile = stubFileExists(present);
    const origSpawn = _executorDeps.spawn;
    _executorDeps.spawn = ((_cmd: string[], _opts: any) => ({
      exited: Promise.resolve(1),
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("  (fail) AC-2: present boom\n"));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    })) as unknown as typeof _executorDeps.spawn; // test-ratchet-allow: as-unknown-as
    try {
      const ctx = makeCtx({
        acceptanceTestPaths: [
          {
            testPath: "/missing/missing.test.ts",
            packageDir: "/missing",
            storyCount: 1,
            acceptanceEnabled: true,
          },
          {
            testPath: "/tmp/present.test.ts",
            packageDir: "/present",
            storyCount: 1,
            acceptanceEnabled: true,
          },
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("fail");
      expect(ctx.acceptanceFailures?.failedACs ?? []).toContain("AC-2");
      expect(ctx.acceptanceFailures?.missingTargets ?? []).toContain("/missing");
    } finally {
      _executorDeps.spawn = origSpawn;
      restoreFile();
    }
  });
});
