/**
 * Unit tests for acceptance-loop.ts — US-003 (stub rejection) and #2083
 * (frame-safe regeneration: reads must join onto projectDir so monorepo
 * stories don't silently lose their implementation context).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeDispatchContext, makeNaxConfig, makeTempDir } from "@test/helpers";
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

  beforeEach(() => {
    tmpDir = makeTempDir("nax-regen-stub-test-");
    origAcceptanceSetupExecute = _regenerateDeps.acceptanceSetupExecute;
    origGetLogger = _regenerateDeps.getLogger;
  });

  afterEach(() => {
    (_regenerateDeps as { acceptanceSetupExecute: unknown }).acceptanceSetupExecute = origAcceptanceSetupExecute;
    (_regenerateDeps as { getLogger: unknown }).getLogger = origGetLogger;
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
    const implContent = "export function add(a: number, b: number) { return a + b; }";

    mkdirSync(join(packageDir, "src"), { recursive: true });
    await Bun.write(implAbsPath, implContent);

    const testPath = join(packageDir, ".nax-acceptance.test.ts");
    await Bun.write(testPath, "original test content");

    // spawnGitDiff returns repo-rooted paths. The fix threads the story's
    // package as a pathspec so cross-package bleeds don't fill the 50KB budget.
    const spawnMock = mock(async (_workdir: string, _ref: string, _pathspec?: string) => implRelPath);
    (_regenerateDeps as { spawnGitDiff: unknown }).spawnGitDiff = spawnMock;
    // Leave _regenerateDeps.readFile at the default (Bun.file(...).text()) so
    // the read actually hits the disk — proves the join resolves to a real
    // file. A path that doesn't exist would throw and be skipped silently.

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
      storyGitRef: "abc1234",
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

    // The implementationContext must carry the read content — proving the
    // join landed on the real file. Before the fix, the join produces
    // `<packageDir>/packages/api/src/add.ts` (does not exist) and the read
    // throws; the catch swallows and implementationContext ends up undefined.
    expect(capturedCtxs).toHaveLength(1);
    const passed = capturedCtxs[0];
    expect(passed.implementationContext).toBeDefined();
    expect(passed.implementationContext).toHaveLength(1);
    expect(passed.implementationContext?.[0].path).toBe(implRelPath);
    expect(passed.implementationContext?.[0].content).toBe(implContent);

    // The spawn must receive the story's package so the diff can't pull in
    // other packages' diffs and fill the 50KB budget — mirrors the shape of
    // captureOutputFiles (src/utils/git.ts:484-501).
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [calledWorkdir, calledRef, calledPathspec] = spawnMock.mock.calls[0];
    expect(calledWorkdir).toBe(packageDir);
    expect(calledRef).toBe("abc1234");
    expect(calledPathspec).toBe("packages/api/");
  });
});
