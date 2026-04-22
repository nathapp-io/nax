/**
 * Unit tests for promptStage acceptance context injection — US-001 AC6–AC8
 *
 * RED phase: tests will fail until promptStage reads ctx.acceptanceTestPaths
 * and calls builder.acceptanceContext() with the loaded content.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { _promptStageDeps, promptStage } from "../../../../src/pipeline/stages/prompt";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import { makeSparseNaxConfig, makeStory } from "../../../helpers";

const WORKDIR = `/tmp/nax-prompt-acceptance-${randomUUID()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePRD(): PRD {
  return {
    project: "test",
    feature: "acceptance-bridge",
    branchName: "feat/bridge",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory({ status: "in-progress", passes: false, attempts: 0, acceptanceCriteria: ["AC1"] })],
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const story = makeStory({ status: "in-progress", passes: false, attempts: 0, acceptanceCriteria: ["AC1"] });
  return {
    config: makeSparseNaxConfig({ agent: { default: "test-agent" }, models: {}, execution: { sessionTimeoutSeconds: 60, dangerouslySkipPermissions: false, costLimit: 10, maxIterations: 10, rectification: { maxRetries: 3 } } }),
    rootConfig: makeSparseNaxConfig({ agent: { default: "test-agent" }, models: {}, execution: { sessionTimeoutSeconds: 60, dangerouslySkipPermissions: false, costLimit: 10, maxIterations: 10, rectification: { maxRetries: 3 } } }),
    prd: makePRD(),
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd-simple",
      reasoning: "",
    },
    workdir: WORKDIR,
    hooks: {} as PipelineContext["hooks"],
    ...overrides,
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// _deps injection setup
// ─────────────────────────────────────────────────────────────────────────────

type ReadFileFn = typeof _promptStageDeps.readFile;
let origReadFile: ReadFileFn;

beforeEach(() => {
  origReadFile = _promptStageDeps.readFile;
});

afterEach(() => {
  _promptStageDeps.readFile = origReadFile;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: when acceptanceTestPaths is undefined, acceptanceContext() is not called
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage.execute() — acceptanceTestPaths undefined/empty", () => {
  test("readFile is not called when ctx.acceptanceTestPaths is undefined", async () => {
    const readFileMock = mock(async (_path: string) => ({ exists: false, text: "" }));
    _promptStageDeps.readFile = readFileMock;

    const ctx = makeCtx({ acceptanceTestPaths: undefined });
    await promptStage.execute(ctx);

    expect(readFileMock).not.toHaveBeenCalled();
  });

  test("readFile is not called when ctx.acceptanceTestPaths is empty array", async () => {
    const readFileMock = mock(async (_path: string) => ({ exists: false, text: "" }));
    _promptStageDeps.readFile = readFileMock;

    const ctx = makeCtx({ acceptanceTestPaths: [] });
    await promptStage.execute(ctx);

    expect(readFileMock).not.toHaveBeenCalled();
  });

  test("prompt is generated normally when acceptanceTestPaths is undefined", async () => {
    const ctx = makeCtx({ acceptanceTestPaths: undefined });
    const result = await promptStage.execute(ctx);
    expect(result.action).toBe("continue");
    expect(ctx.prompt).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: when acceptanceTestPaths is set, readFile is called for each path
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage.execute() — reads acceptanceTestPaths files", () => {
  test("readFile is called for each entry in ctx.acceptanceTestPaths", async () => {
    const readFileMock = mock(async (_path: string) => ({
      exists: true,
      text: "// acceptance test content",
    }));
    _promptStageDeps.readFile = readFileMock;

    const ctx = makeCtx({
      acceptanceTestPaths: [
        { testPath: "/feature/test/a.test.ts", packageDir: "/feature" },
        { testPath: "/feature/test/b.test.ts", packageDir: "/feature" },
      ],
    });
    await promptStage.execute(ctx);

    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(readFileMock).toHaveBeenCalledWith("/feature/test/a.test.ts");
    expect(readFileMock).toHaveBeenCalledWith("/feature/test/b.test.ts");
  });

  test("prompt includes acceptance test content when files exist", async () => {
    _promptStageDeps.readFile = mock(async (_path: string) => ({
      exists: true,
      text: "ACCEPTANCE_FILE_CONTENT_MARKER",
    }));

    const ctx = makeCtx({
      acceptanceTestPaths: [
        { testPath: "/feature/acceptance.test.ts", packageDir: "/feature" },
      ],
    });
    await promptStage.execute(ctx);

    expect(ctx.prompt).toContain("ACCEPTANCE_FILE_CONTENT_MARKER");
  });

  test("prompt includes the test path in the acceptance section", async () => {
    _promptStageDeps.readFile = mock(async (_path: string) => ({
      exists: true,
      text: "// some test",
    }));

    const ctx = makeCtx({
      acceptanceTestPaths: [
        { testPath: "/feature/acceptance.test.ts", packageDir: "/feature" },
      ],
    });
    await promptStage.execute(ctx);

    expect(ctx.prompt).toContain("/feature/acceptance.test.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: non-existent files are skipped with a debug log
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage.execute() — skips non-existent files", () => {
  test("skips file that does not exist (exists=false) without throwing", async () => {
    _promptStageDeps.readFile = mock(async (filePath: string) => {
      if (filePath.includes("missing")) return { exists: false, text: "" };
      return { exists: true, text: "REAL_CONTENT" };
    });

    const ctx = makeCtx({
      acceptanceTestPaths: [
        { testPath: "/feature/missing.test.ts", packageDir: "/feature" },
        { testPath: "/feature/real.test.ts", packageDir: "/feature" },
      ],
    });

    await expect(promptStage.execute(ctx)).resolves.toMatchObject({ action: "continue" });
  });

  test("non-existent file content is not included in the prompt", async () => {
    _promptStageDeps.readFile = mock(async (filePath: string) => {
      if (filePath.includes("missing")) return { exists: false, text: "" };
      return { exists: true, text: "PRESENT_CONTENT_MARKER" };
    });

    const ctx = makeCtx({
      acceptanceTestPaths: [
        { testPath: "/feature/missing.test.ts", packageDir: "/feature" },
        { testPath: "/feature/real.test.ts", packageDir: "/feature" },
      ],
    });
    await promptStage.execute(ctx);

    expect(ctx.prompt).not.toContain("/feature/missing.test.ts");
    expect(ctx.prompt).toContain("PRESENT_CONTENT_MARKER");
  });
});
