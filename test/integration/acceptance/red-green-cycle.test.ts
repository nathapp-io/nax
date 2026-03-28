/**
 * Integration test: RED to GREEN acceptance cycle
 *
 * Validates the full acceptance pipeline flow:
 * 1. acceptance-setup generates tests, RED gate detects failures
 * 2. After implementation stubs are written, GREEN gate detects passing tests
 *
 * Uses _deps injection for LLM calls and RED gate (no real Claude invocations).
 * GREEN gate runs real bun test on actual files written to a temp directory.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../../../src/config";
import { initLogger, resetLogger } from "../../../src/logger";
import { acceptanceStage } from "../../../src/pipeline/stages/acceptance";
import {
  _acceptanceSetupDeps,
  acceptanceSetupStage,
  computeACFingerprint,
} from "../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD } from "../../../src/prd/types";
import { makeTempDir } from "../../helpers/temp";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(
  id: string,
  acceptanceCriteria: string[],
  status: "pending" | "passed" | "failed" | "skipped" | "in-progress" = "pending",
) {
  return {
    id,
    title: `Story ${id}`,
    description: "Test description",
    acceptanceCriteria,
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 0,
  };
}

function makePrd(stories: ReturnType<typeof makeStory>[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeCtx(tmpDir: string, overrides: Partial<PipelineContext> = {}): PipelineContext {
  const featureDir = path.join(tmpDir, ".nax/features/test-feature");
  const stories = [
    makeStory("US-001", ["AC-1: first feature works", "AC-2: second feature works"]),
    makeStory("US-002", ["AC-1: third feature works"]),
  ];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement: true,
        redGate: true,
        model: "fast",
      },
    } as unknown as PipelineContext["config"],
    prd: makePrd(stories),
    story: stories[0],
    stories,
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "",
    },
    workdir: tmpDir,
    featureDir,
    hooks: { hooks: {} } as unknown as PipelineContext["hooks"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(async () => {
  initLogger({ level: "error", useChalk: false });
  tmpDir = makeTempDir("nax-acc-cycle-");
  const featureDir = path.join(tmpDir, ".nax/features/test-feature");
  await fs.mkdir(featureDir, { recursive: true });
  savedDeps = { ..._acceptanceSetupDeps };
});

afterEach(async () => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  mock.restore();
  resetLogger();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-1 + AC-2 + AC-3: Full RED to GREEN cycle
// ---------------------------------------------------------------------------

describe("RED to GREEN acceptance cycle", () => {
  test("acceptance-setup writes test file and RED gate detects failures", async () => {
    const testPath = path.join(tmpDir, ".nax-acceptance.test.ts");

    const generatedTestCode = [
      'import { test } from "bun:test";',
      'test("AC-1: first feature works", () => { throw new Error("NOT_IMPLEMENTED") });',
      'test("AC-2: second feature works", () => { throw new Error("NOT_IMPLEMENTED") });',
      'test("AC-1: third feature works", () => { throw new Error("NOT_IMPLEMENTED") });',
    ].join("\n");

    // Mock LLM calls — no real Claude invocations
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({ testCode: generatedTestCode, criteria: [] });

    let writtenPath = "";
    let writtenContent = "";
    _acceptanceSetupDeps.writeFile = async (p, content) => {
      writtenPath = p;
      writtenContent = content;
      await Bun.write(p, content);
    };

    // RED gate: tests fail before implementation
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "3 failed\n0 passed" });

    const ctx = makeCtx(tmpDir);
    const setupResult = await acceptanceSetupStage.execute(ctx);

    // acceptance.test.ts must be written to the feature dir
    expect(writtenPath).toBe(testPath);
    expect(writtenContent).toBe(generatedTestCode);

    // RED gate detects failures — valid RED, stage continues
    expect(setupResult.action).toBe("continue");
    const contextWithSetup = ctx as unknown as Record<string, unknown>;
    expect((contextWithSetup.acceptanceSetup as Record<string, unknown>).redFailCount).toBeGreaterThan(0);
  });

  test("GREEN gate passes after implementation stubs are written", async () => {
    const testPath = path.join(tmpDir, ".nax-acceptance.test.ts");

    // Write a real passing acceptance test file (simulating post-implementation state)
    const passingTestCode = [
      'import { test, expect } from "bun:test";',
      'test("AC-1: first feature works", () => { expect(true).toBe(true); });',
      'test("AC-2: second feature works", () => { expect(true).toBe(true); });',
      'test("AC-1: third feature works", () => { expect(true).toBe(true); });',
    ].join("\n");
    await Bun.write(testPath, passingTestCode);

    // All stories must be complete for acceptanceStage.enabled() to return true
    const completedStories = [
      makeStory("US-001", ["AC-1: first feature works", "AC-2: second feature works"], "passed"),
      makeStory("US-002", ["AC-1: third feature works"], "passed"),
    ];
    const greenCtx = makeCtx(tmpDir, {
      prd: makePrd(completedStories) as unknown as PRD,
      story: completedStories[0],
      stories: completedStories,
      acceptanceTestPaths: [{ testPath, packageDir: tmpDir }],
    });

    expect(acceptanceStage.enabled(greenCtx)).toBe(true);

    // GREEN gate: run real bun test — tests now pass
    const greenResult = await acceptanceStage.execute(greenCtx);
    expect(greenResult.action).toBe("continue");
  });

  test("full RED then GREEN: setup stage continues on RED, acceptance stage continues on GREEN", async () => {
    const testPath = path.join(tmpDir, ".nax-acceptance.test.ts");

    // --- RED phase ---
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'import { test } from "bun:test"; test("placeholder", () => { throw new Error("RED") });',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async (p, content) => {
      await Bun.write(p, content);
    };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 failed" });

    const redCtx = makeCtx(tmpDir);
    const redResult = await acceptanceSetupStage.execute(redCtx);
    expect(redResult.action).toBe("continue");

    // --- GREEN phase: simulate implementation by overwriting with passing tests ---
    const passingTestCode = [
      'import { test, expect } from "bun:test";',
      'test("AC-1: first feature works", () => { expect(true).toBe(true); });',
    ].join("\n");
    await Bun.write(testPath, passingTestCode);

    const completedStories = [
      makeStory("US-001", ["AC-1: first feature works", "AC-2: second feature works"], "passed"),
      makeStory("US-002", ["AC-1: third feature works"], "passed"),
    ];
    const greenCtx = makeCtx(tmpDir, {
      prd: makePrd(completedStories) as unknown as PRD,
      story: completedStories[0],
      stories: completedStories,
      acceptanceTestPaths: [{ testPath, packageDir: tmpDir }],
    });

    const greenResult = await acceptanceStage.execute(greenCtx);
    expect(greenResult.action).toBe("continue");
  });
});

// ---------------------------------------------------------------------------
// AC-4: Edge case — acceptance.test.ts already exists → skip generation
// ---------------------------------------------------------------------------

describe("edge case: pre-existing .nax-acceptance.test.ts", () => {
  test("skips generation when .nax-acceptance.test.ts already exists at package root and fingerprint matches", async () => {
    const testPath = path.join(tmpDir, ".nax-acceptance.test.ts");

    // Pre-write a test file as if from a previous nax analyze run
    await Bun.write(testPath, 'import { test } from "bun:test"; test("existing", () => {});');

    let refineCalled = false;
    let generateCalled = false;

    // Compute matching fingerprint for the ACs in makeCtx
    const matchingFingerprint = computeACFingerprint([
      "AC-1: first feature works",
      "AC-2: second feature works",
      "AC-1: third feature works",
    ]);

    _acceptanceSetupDeps.fileExists = async (p) => {
      const f = Bun.file(p);
      return f.exists();
    };
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: matchingFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.refine = async () => {
      refineCalled = true;
      return [];
    };
    _acceptanceSetupDeps.generate = async () => {
      generateCalled = true;
      return { testCode: "", criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    // RED gate still runs even with pre-existing file
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 failed" });

    const ctx = makeCtx(tmpDir);
    const result = await acceptanceSetupStage.execute(ctx);

    // Generation skipped — file already exists with matching fingerprint
    expect(refineCalled).toBe(false);
    expect(generateCalled).toBe(false);

    // RED gate still runs and detects failures → continue
    expect(result.action).toBe("continue");
  });

  test("does not overwrite the pre-existing .nax-acceptance.test.ts when fingerprint matches", async () => {
    const testPath = path.join(tmpDir, ".nax-acceptance.test.ts");

    const originalContent = "// pre-existing test content";
    await Bun.write(testPath, originalContent);

    const matchingFingerprint = computeACFingerprint([
      "AC-1: first feature works",
      "AC-2: second feature works",
      "AC-1: third feature works",
    ]);

    let writeFileCalled = false;
    _acceptanceSetupDeps.fileExists = async (p) => {
      const f = Bun.file(p);
      return f.exists();
    };
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: matchingFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.refine = async () => [];
    _acceptanceSetupDeps.generate = async () => ({ testCode: "", criteria: [] });
    _acceptanceSetupDeps.writeFile = async () => {
      writeFileCalled = true;
    };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 failed" });

    await acceptanceSetupStage.execute(makeCtx(tmpDir));

    expect(writeFileCalled).toBe(false);

    // Original content preserved on disk
    const diskContent = await Bun.file(testPath).text();
    expect(diskContent).toBe(originalContent);
  });
});

// ---------------------------------------------------------------------------
// AC-5: Edge case — all tests already pass → warn and skip acceptance
// ---------------------------------------------------------------------------

describe("edge case: already-passing tests trigger skip", () => {
  test("returns skip when RED gate finds all tests passing before implementation", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'import { test } from "bun:test"; test("AC-1", () => { /* passes */ });',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    // All tests pass even before implementation — invalid RED
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 0, output: "3 passed" });

    const ctx = makeCtx(tmpDir);
    const result = await acceptanceSetupStage.execute(ctx);

    // Tests passing before implementation — not testing new behavior
    expect(result.action).toBe("skip");
  });

  test("skip result includes a human-readable reason explaining the warning", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'import { test } from "bun:test"; test("AC-1", () => {});',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 0, output: "1 passed" });

    const ctx = makeCtx(tmpDir);
    const result = await acceptanceSetupStage.execute(ctx);

    expect(result.action).toBe("skip");
    if (result.action === "skip") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: _deps injection used for all process spawning (no real LLM calls)
// ---------------------------------------------------------------------------

describe("_deps injection: no real LLM calls", () => {
  test("refine dep is called instead of making real LLM calls", async () => {
    let refineDepsInvoked = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.refine = async (criteria) => {
      refineDepsInvoked = true;
      return criteria.map((c) => ({ original: c, refined: `[mocked] ${c}`, testable: true, storyId: "US-001" }));
    };
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'import { test } from "bun:test"; test("AC-1", () => { throw new Error("RED") });',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 failed" });

    await acceptanceSetupStage.execute(makeCtx(tmpDir));

    // Confirms the injected dep was called (not the real LLM adapter)
    expect(refineDepsInvoked).toBe(true);
  });

  test("generate dep is called instead of making real LLM calls", async () => {
    let generateDepsInvoked = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => {
      generateDepsInvoked = true;
      return {
        testCode: 'import { test } from "bun:test"; test("AC-1", () => { throw new Error("RED") });',
        criteria: [],
      };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 failed" });

    await acceptanceSetupStage.execute(makeCtx(tmpDir));

    expect(generateDepsInvoked).toBe(true);
  });

  test("runTest dep controls RED gate without spawning a real process", async () => {
    let runTestDepsInvoked = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'import { test } from "bun:test"; test("AC-1", () => { throw new Error("RED") });',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async (_testPath, _workdir) => {
      runTestDepsInvoked = true;
      return { exitCode: 1, output: "injected: 1 failed" };
    };

    const ctx = makeCtx(tmpDir);
    const result = await acceptanceSetupStage.execute(ctx);

    expect(runTestDepsInvoked).toBe(true);
    expect(result.action).toBe("continue");
  });
});
