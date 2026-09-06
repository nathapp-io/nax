/**
 * Unit tests for acceptance-loop.ts — US-003: Stub content rejection in regenerateAcceptanceTest
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
});
