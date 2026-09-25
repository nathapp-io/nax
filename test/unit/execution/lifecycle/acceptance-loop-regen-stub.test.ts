/**
 * Unit tests for acceptance-loop.ts — US-003 (stub rejection) and #2083
 * (frame-safe regeneration: reads must join onto projectDir so monorepo
 * stories don't silently lose their implementation context).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeDispatchContext, makeNaxConfig, makeTempDir } from "@test/helpers";
import { isTestLevelFailure } from "@/execution/lifecycle/acceptance-helpers";
import { _regenerateDeps, regenerateAcceptanceTest } from "@/execution/lifecycle/acceptance-loop";
import type { PipelineContext } from "@/pipeline/types";

function makeMinimalPipelineContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: makeNaxConfig({ acceptance: { maxRetries: 1 }, agent: { default: "claude" } }),
    rootConfig: makeNaxConfig({ acceptance: { maxRetries: 1 }, agent: { default: "claude" } }),
    prd: { project: "p", feature: "f", branchName: "b", createdAt: "", updatedAt: "", userStories: [] },
    story: {
      id: "US-001",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      dependencies: [],
      tags: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    },
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "no-test", reasoning: "" },
    workdir: "/tmp/workdir",
    projectDir: "/tmp/workdir",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// US-003: regenerateAcceptanceTest stub rejection
// ─────────────────────────────────────────────────────────────────────────────

describe("regenerateAcceptanceTest — rejects stub content (US-003)", () => {
  let tmpDir: string;
  let origAcceptanceSetupExecute: typeof _regenerateDeps.acceptanceSetupExecute;
  let origGetLogger: typeof _regenerateDeps.getLogger;
  let origSpawnGitDiff: typeof _regenerateDeps.spawnGitDiff;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-regen-stub-test-");
    origAcceptanceSetupExecute = _regenerateDeps.acceptanceSetupExecute;
    origGetLogger = _regenerateDeps.getLogger;
    origSpawnGitDiff = _regenerateDeps.spawnGitDiff;
  });

  afterEach(() => {
    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = origAcceptanceSetupExecute;
    (_regenerateDeps as { getLogger: unknown }).getLogger = origGetLogger;
    (_regenerateDeps as { spawnGitDiff: unknown }).spawnGitDiff = origSpawnGitDiff;
    cleanupTempDir(tmpDir);
  });

  // AC-1: returns false when stub content at target path
  test("returns false when the acceptance-setup stage leaves stub content at the target path", async () => {
    const testPath = join(tmpDir, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {
      await Bun.write(testPath, 'test("AC-1: stub", async () => { expect(true).toBe(true); });');
    });

    const ctx = makeMinimalPipelineContext({ workdir: tmpDir });
    const result = await regenerateAcceptanceTest(testPath, ctx);

    expect(result).toBe(false);
  });

  // AC-2: returns true when real content at target path
  test("returns true when the acceptance-setup stage leaves real test content at the target path", async () => {
    const testPath = join(tmpDir, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {
      const realContent = `
test("AC-1: real test", async () => {
  const result = add(1, 2);
  expect(result).toBe(3);
});
`;
      await Bun.write(testPath, realContent);
    });

    const ctx = makeMinimalPipelineContext({ workdir: tmpDir });
    const result = await regenerateAcceptanceTest(testPath, ctx);

    expect(result).toBe(true);
  });

  // AC-3: returns false when no file at target path
  test("returns false when the acceptance-setup stage leaves no file at the target path", async () => {
    const testPath = join(tmpDir, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {});

    const ctx = makeMinimalPipelineContext({ workdir: tmpDir });
    const result = await regenerateAcceptanceTest(testPath, ctx);

    expect(result).toBe(false);
  });

  // AC-4: distinct error logs for stub vs missing
  test("logs at error level with distinct message when target path holds stub content", async () => {
    const testPath = join(tmpDir, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    const errorLogs: Array<{ stage: string; message: string }> = [];

    const mockLogger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock((stage: string, message: string) => {
        errorLogs.push({ stage, message });
      }),
      debug: mock(() => {}),
    };
    (_regenerateDeps as { getLogger: unknown }).getLogger = mock(() => mockLogger);

    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {
      await Bun.write(testPath, 'test("AC-1: stub", async () => { expect(true).toBe(true); });');
    });

    const ctx = makeMinimalPipelineContext({ workdir: tmpDir });
    await regenerateAcceptanceTest(testPath, ctx);

    const stubErrors = errorLogs.filter((l) => l.stage === "acceptance" && l.message.toLowerCase().includes("stub"));
    expect(stubErrors.length).toBeGreaterThan(0);
  });

  test("logs at error level with distinct message when file is missing entirely", async () => {
    const testPath = join(tmpDir, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    const errorLogs: Array<{ stage: string; message: string }> = [];

    const mockLogger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock((stage: string, message: string) => {
        errorLogs.push({ stage, message });
      }),
      debug: mock(() => {}),
    };
    (_regenerateDeps as { getLogger: unknown }).getLogger = mock(() => mockLogger);

    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {});

    const ctx = makeMinimalPipelineContext({ workdir: tmpDir });
    await regenerateAcceptanceTest(testPath, ctx);

    const missingErrors = errorLogs.filter(
      (l) => l.stage === "acceptance" && l.message.toLowerCase().includes("not created"),
    );
    expect(missingErrors.length).toBeGreaterThan(0);
  });

  test("stub and missing-file error messages are distinct", async () => {
    const testPath = join(tmpDir, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    const stubLogs: string[] = [];
    const stubLogger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock((_stage: string, message: string) => {
        stubLogs.push(message);
      }),
      debug: mock(() => {}),
    };
    (_regenerateDeps as { getLogger: unknown }).getLogger = mock(() => stubLogger);

    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {
      await Bun.write(testPath, 'test("AC-1: stub", async () => { expect(true).toBe(true); });');
    });

    const ctx = makeMinimalPipelineContext({ workdir: tmpDir });
    await regenerateAcceptanceTest(testPath, ctx);

    await Bun.write(testPath, "new content");

    const missingLogs: string[] = [];
    const missingLogger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock((_stage: string, message: string) => {
        missingLogs.push(message);
      }),
      debug: mock(() => {}),
    };
    (_regenerateDeps as { getLogger: unknown }).getLogger = mock(() => missingLogger);

    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {});

    await regenerateAcceptanceTest(testPath, ctx);

    const stubErrorMsg = stubLogs.find((m) => m.toLowerCase().includes("stub"));
    const missingErrorMsg = missingLogs.find((m) => m.toLowerCase().includes("not created"));

    expect(stubErrorMsg).toBeDefined();
    expect(missingErrorMsg).toBeDefined();
    expect(stubErrorMsg).not.toEqual(missingErrorMsg);
  });

  // AC-5: writes backup before running acceptance-setup
  test("writes the target path's pre-existing content to a .bak sibling before invoking acceptance-setup", async () => {
    const testPath = join(tmpDir, ".nax-acceptance.test.ts");
    const originalContent = "original test content to be backed up";
    await Bun.write(testPath, originalContent);

    let acceptanceSetupCalled = false;
    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {
      acceptanceSetupCalled = true;
      const bakPath = `${testPath}.bak`;
      const bakExists = await Bun.file(bakPath).exists();
      expect(bakExists).toBe(true);
      const bakContent = await Bun.file(bakPath).text();
      expect(bakContent).toBe(originalContent);
    });

    const ctx = makeMinimalPipelineContext({ workdir: tmpDir });
    await regenerateAcceptanceTest(testPath, ctx);

    expect(acceptanceSetupCalled).toBe(true);
    const bakPath = `${testPath}.bak`;
    const bakContent = await Bun.file(bakPath).text();
    expect(bakContent).toBe(originalContent);
  });

  test("writes backup regardless of whether regeneration ultimately succeeds or fails", async () => {
    const testPath = join(tmpDir, ".nax-acceptance.test.ts");
    const originalContent = "original content for backup";
    await Bun.write(testPath, originalContent);

    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {
      await Bun.write(testPath, 'test("stub", async () => { expect(true).toBe(true); });');
    });

    const ctx = makeMinimalPipelineContext({ workdir: tmpDir });
    await regenerateAcceptanceTest(testPath, ctx);

    let bakContent = await Bun.file(`${testPath}.bak`).text();
    expect(bakContent).toBe(originalContent);

    await Bun.write(testPath, "new content");
    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {});

    await regenerateAcceptanceTest(testPath, ctx);

    bakContent = await Bun.file(`${testPath}.bak`).text();
    expect(bakContent).toBe("new content");
  });

  // #2083: spawnGitDiff returns repo-rooted paths (no --relative, no pathspec)
  // because the spawn runs `git diff --name-only <ref>` in cwd. When the
  // acceptance context's workdir is a package dir beneath projectDir (the
  // canonical monorepo shape: pipeline/types.ts:83-93), joining the diff
  // output onto workdir produces a non-existent nested path
  // (`<packageDir>/<repoFramedPath>`) and the read silently swallows the
  // ENOENT — implementationContext ends up undefined. Reads must join onto
  // `projectDir ?? workdir` (the `repoRoot` already computed above) so the
  // read lands on the real file on disk. Placed in this file (rather than
  // acceptance-loop.test.ts) because adding it there pushed the parent past
  // the 800-line test limit.
  test("reads implementation files from projectDir (repo root), not workdir (#2083)", async () => {
    const { mkdirSync } = await import("node:fs");

    // Layout:
    //   tmpDir/                                       (= projectDir, the repo root)
    //   tmpDir/packages/api/                          (= workdir, the package dir)
    //   tmpDir/packages/api/src/add.ts                (the real implementation file)
    //   tmpDir/packages/api/.nax-acceptance.test.ts   (the test to regenerate)
    const repoRoot = tmpDir;
    const packageDir = join(repoRoot, "packages", "api");
    const implRelPath = "packages/api/src/add.ts";
    const implAbsPath = join(repoRoot, implRelPath);
    const implContentBefore = "export function add(a: number, b: number) { return a + b; }";
    const implContentAfter = "export function add(a: number, b: number) { return a + b + 0; }";

    mkdirSync(join(packageDir, "src"), { recursive: true });

    // A REAL git repo, not a mock: this is the exact shape the pinned test
    // was blind to (path-frame follow-up H1/H2) — a mocked spawnGitDiff that
    // ignores both `cwd` and `pathspec` can't tell a correct
    // (cwd, pathspec) combination from the broken one the code actually
    // sends. `spawnGitDiff` spawns with `cwd: workdir`, and this file's own
    // comment says workdir is the package dir in a monorepo — a repo-rooted
    // pathspec ("packages/api/") handed to a package-dir cwd resolves to
    // "<repoRoot>/packages/api/packages/api/" and git returns nothing, exit
    // 0. Only a real git process reproduces that.
    await Bun.spawn(["git", "init"], { cwd: repoRoot }).exited;
    await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: repoRoot }).exited;
    await Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: repoRoot }).exited;

    await Bun.write(implAbsPath, implContentBefore);
    await Bun.spawn(["git", "add", "-A"], { cwd: repoRoot }).exited;
    await Bun.spawn(["git", "commit", "-m", "base"], { cwd: repoRoot }).exited;
    const baseRefProc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repoRoot, stdout: "pipe" });
    const baseRef = (await new Response(baseRefProc.stdout).text()).trim();
    await baseRefProc.exited;

    // The story's implementation commit: what storyGitRef must diff AGAINST.
    await Bun.write(implAbsPath, implContentAfter);
    await Bun.spawn(["git", "add", "-A"], { cwd: repoRoot }).exited;
    await Bun.spawn(["git", "commit", "-m", "implement US-001"], { cwd: repoRoot }).exited;

    const testPath = join(packageDir, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    // Real spawnGitDiff (not mocked) and real readFile — both must land on
    // the actual files on disk for this test to pass.

    const capturedCtxs: Array<PipelineContext & { implementationContext?: Array<{ path: string; content: string }> }> =
      [];
    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(
      async (ctx: PipelineContext & { implementationContext?: Array<{ path: string; content: string }> }) => {
        capturedCtxs.push(ctx);
      },
    );

    const ctx = makeMinimalPipelineContext({
      workdir: packageDir,
      projectDir: repoRoot,
      storyGitRef: baseRef,
      story: {
        id: "US-001",
        title: "t",
        description: "d",
        acceptanceCriteria: [],
        dependencies: [],
        tags: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        workdir: "packages/api",
      },
    });

    await regenerateAcceptanceTest(testPath, ctx);

    // The implementationContext must carry the read content — proving both
    // that git found the changed file (the cwd/pathspec combination works)
    // AND that the read landed on the real file. Before the fix,
    // spawnGitDiff ran with cwd=packageDir and pathspec="packages/api/",
    // git returned nothing, changedFiles was empty, and
    // implementationContext stayed undefined — silently, exit 0, no warn.
    expect(capturedCtxs).toHaveLength(1);
    const passed = capturedCtxs[0];
    expect(passed.implementationContext).toBeDefined();
    expect(passed.implementationContext).toHaveLength(1);
    expect(passed.implementationContext?.[0].path).toBe(implRelPath);
    expect(passed.implementationContext?.[0].content).toBe(implContentAfter);
  });

  // #2083 polish: exercise both `logger?.warn` branches added by the
  // frame-safe read fix. Captured-logger pattern mirrors the error-log tests
  // above; the first triggers the outer `catch` (spawnGitDiff throws), the
  // second triggers the inner per-file `catch` (the file is unlinked before
  // the read loop sees it).
  test("warns with the git-diff-failed message when spawnGitDiff throws (#2083)", async () => {
    const testPath = join(tmpDir, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    const warnLogs: Array<{ stage: string; message: string }> = [];
    const capturedLogger = {
      info: mock(() => {}),
      warn: mock((stage: string, message: string) => {
        warnLogs.push({ stage, message });
      }),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    (_regenerateDeps as { getLogger: unknown }).getLogger = mock(() => capturedLogger);

    (_regenerateDeps as { spawnGitDiff: unknown }).spawnGitDiff = mock(async () => {
      throw new Error("git exploded");
    });

    // Ensure acceptance-setup leaves real content so we only see the warn,
    // not a stub-rejection error.
    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {
      await Bun.write(testPath, 'test("AC-1: real", async () => { expect(true).toBe(true); });');
    });

    const ctx = makeMinimalPipelineContext({ workdir: tmpDir, storyGitRef: "abc1234" });
    await regenerateAcceptanceTest(testPath, ctx);

    const diffFailLogs = warnLogs.filter((l) => l.stage === "acceptance" && l.message.includes("git diff failed"));
    expect(diffFailLogs.length).toBeGreaterThan(0);
    expect(diffFailLogs[0].message).toContain("abc1234");
  });

  test("warns with the unreadable-file message when a diff'd file is gone by read time (#2083)", async () => {
    const { existsSync, mkdirSync, unlinkSync } = await import("node:fs");

    // Layout: tmpDir (= repo root) / packages/api/src/x.ts. The spawn returns
    // the repo-framed path AND unlinks the file before returning, so the
    // readFile that follows hits ENOENT and trips the inner per-file catch.
    const repoRoot = tmpDir;
    const implRelPath = "packages/api/src/x.ts";
    const implAbsPath = join(repoRoot, implRelPath);
    mkdirSync(join(repoRoot, "packages", "api", "src"), { recursive: true });
    await Bun.write(implAbsPath, "export const x = 1;");

    const testPath = join(repoRoot, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    (_regenerateDeps as { spawnGitDiff: unknown }).spawnGitDiff = mock(async () => {
      if (existsSync(implAbsPath)) unlinkSync(implAbsPath);
      return implRelPath;
    });

    const warnLogs: Array<{ stage: string; message: string }> = [];
    const capturedLogger = {
      info: mock(() => {}),
      warn: mock((stage: string, message: string) => {
        warnLogs.push({ stage, message });
      }),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    (_regenerateDeps as { getLogger: unknown }).getLogger = mock(() => capturedLogger);

    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = mock(async () => {
      await Bun.write(testPath, 'test("AC-1: real", async () => { expect(true).toBe(true); });');
    });

    const ctx = makeMinimalPipelineContext({
      workdir: repoRoot,
      projectDir: repoRoot,
      storyGitRef: "abc1234",
    });
    await regenerateAcceptanceTest(testPath, ctx);

    const unreadableLogs = warnLogs.filter((l) => l.stage === "acceptance" && l.message.includes("unreadable"));
    expect(unreadableLogs.length).toBeGreaterThan(0);
    // Backtick-delimited paths (MIN-2) — assert the wrapping survives the join.
    expect(unreadableLogs[0].message).toContain(`\`${implRelPath}\``);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isTestLevelFailure — test-level failure heuristic (US-005)
// ─────────────────────────────────────────────────────────────────────────────

describe("isTestLevelFailure — failed-ratio heuristic", () => {
  test("US-005 AC5: returns false for 1 of 10 ACs failed", () => {
    expect(isTestLevelFailure(["AC-1"], 10)).toBe(false);
  });

  test("US-005 AC6: returns true for 9 of 10 ACs failed", () => {
    expect(isTestLevelFailure(["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-9"], 10)).toBe(true);
  });

  test("boundary: exactly 80% failed is not above the threshold and returns false", () => {
    const eightFailed = Array.from({ length: 8 }, (_, i) => `AC-${i + 1}`);
    expect(isTestLevelFailure(eightFailed, 10)).toBe(false);
  });

  test("accepts a numeric failed count as well as a list", () => {
    expect(isTestLevelFailure(9, 10)).toBe(true);
    expect(isTestLevelFailure(1, 10)).toBe(false);
  });

  test("returns false when totalACs is 0 regardless of failedACs", () => {
    expect(isTestLevelFailure(["AC-1"], 0)).toBe(false);
    expect(isTestLevelFailure(5, 0)).toBe(false);
  });
});

describe("isTestLevelFailure — AC-ERROR sentinel", () => {
  test("US-005 AC7: returns true for a lone AC-ERROR sentinel", () => {
    expect(isTestLevelFailure(["AC-ERROR"], 10)).toBe(true);
  });

  test("returns true when AC-ERROR is mixed with real AC failures", () => {
    expect(isTestLevelFailure(["AC-1", "AC-ERROR", "AC-2"], 10)).toBe(true);
  });

  test("an empty failure list is not an AC-ERROR sentinel", () => {
    expect(isTestLevelFailure([], 10)).toBe(false);
  });
});
