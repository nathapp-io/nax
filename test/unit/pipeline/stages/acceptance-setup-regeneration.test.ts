/**
 * acceptance-setup: P2-A/P2-B — Hash-based regeneration tests
 *
 * Verifies that acceptance-setup detects stale test files via AC fingerprint
 * and regenerates them (with .bak backup) when ACs change.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type AcceptanceMeta,
  _acceptanceSetupDeps,
  acceptanceSetupStage,
  computeACFingerprint,
} from "../../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, acceptanceCriteria: string[]) {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria,
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makePrd(stories: ReturnType<typeof makeStory>[]) {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [
    makeStory("US-001", ["AC-1: first criterion", "AC-2: second criterion"]),
    makeStory("US-002", ["AC-3: third criterion"]),
  ];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement: false,
        redGate: true,
        model: "fast",
      },
    } as any,
    prd: makePrd(stories),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: {} as any,
    ...overrides,
  };
}

// Criteria in default makeCtx
const DEFAULT_CRITERIA = ["AC-1: first criterion", "AC-2: second criterion", "AC-3: third criterion"];

// ---------------------------------------------------------------------------
// Save/restore deps
// ---------------------------------------------------------------------------

let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  mock.restore();
});

// ---------------------------------------------------------------------------
// computeACFingerprint — P2-A unit tests
// ---------------------------------------------------------------------------

describe("computeACFingerprint", () => {
  test("returns a sha256: prefixed string", () => {
    const fp = computeACFingerprint(["AC-1: criterion"]);
    expect(fp).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("same criteria produce same fingerprint", () => {
    const fp1 = computeACFingerprint(["AC-1: a", "AC-2: b"]);
    const fp2 = computeACFingerprint(["AC-1: a", "AC-2: b"]);
    expect(fp1).toBe(fp2);
  });

  test("order-independent — sorts before hashing", () => {
    const fp1 = computeACFingerprint(["AC-1: a", "AC-2: b"]);
    const fp2 = computeACFingerprint(["AC-2: b", "AC-1: a"]);
    expect(fp1).toBe(fp2);
  });

  test("different criteria produce different fingerprints", () => {
    const fp1 = computeACFingerprint(["AC-1: original"]);
    const fp2 = computeACFingerprint(["AC-1: modified"]);
    expect(fp1).not.toBe(fp2);
  });

  test("empty array produces stable fingerprint", () => {
    const fp = computeACFingerprint([]);
    expect(fp).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// P2-A: Regenerate when meta is missing
// ---------------------------------------------------------------------------

describe("acceptance-setup: regenerates when meta is missing (P2-A)", () => {
  test("calls generate when file exists but meta is missing", async () => {
    let generateCalled = false;
    let copyFileCalled = false;
    let deleteFileCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => null; // no meta
    _acceptanceSetupDeps.copyFile = async () => { copyFileCalled = true; };
    _acceptanceSetupDeps.deleteFile = async () => { deleteFileCalled = true; };
    _acceptanceSetupDeps.refine = async (c) => c.map((x) => ({ original: x, refined: x, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => {
      generateCalled = true;
      return { testCode: 'test("AC-1", () => {})', criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(copyFileCalled).toBe(true);
    expect(deleteFileCalled).toBe(true);
    expect(generateCalled).toBe(true);
  });

  test("backs up test file before regenerating when meta is missing", async () => {
    const copySrc: string[] = [];
    const copyDest: string[] = [];

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.copyFile = async (src, dest) => {
      copySrc.push(src);
      copyDest.push(dest);
    };
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.refine = async (c) => c.map((x) => ({ original: x, refined: x, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({ testCode: 'test("AC-1", () => {})', criteria: [] });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(copySrc[0]).toContain("acceptance.test.ts");
    expect(copyDest[0]).toContain("acceptance.test.ts.bak");
  });
});

// ---------------------------------------------------------------------------
// P2-A: Regenerate when fingerprint is stale
// ---------------------------------------------------------------------------

describe("acceptance-setup: regenerates when fingerprint is stale (P2-A)", () => {
  test("regenerates when stored fingerprint differs from current ACs", async () => {
    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: "sha256:outdated_fingerprint",
      storyCount: 2,
      acCount: 2,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.refine = async (c) => c.map((x) => ({ original: x, refined: x, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => {
      generateCalled = true;
      return { testCode: 'test("AC-1", () => {})', criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(generateCalled).toBe(true);
  });

  test("adding a new AC triggers regeneration (AC-12)", async () => {
    const originalCriteria = DEFAULT_CRITERIA;
    const storedFingerprint = computeACFingerprint(originalCriteria);

    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: storedFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.refine = async (c) => c.map((x) => ({ original: x, refined: x, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => {
      generateCalled = true;
      return { testCode: 'test("AC-1", () => {})', criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    // Add a new AC to the context
    const stories = [
      makeStory("US-001", ["AC-1: first criterion", "AC-2: second criterion"]),
      makeStory("US-002", ["AC-3: third criterion", "AC-4: new criterion"]), // extra AC
    ];
    const ctx = makeCtx({ prd: makePrd(stories) as any });

    await acceptanceSetupStage.execute(ctx);

    expect(generateCalled).toBe(true);
  });

  test("modifying an AC triggers regeneration (AC-14)", async () => {
    const storedFingerprint = computeACFingerprint(DEFAULT_CRITERIA);

    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: storedFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.refine = async (c) => c.map((x) => ({ original: x, refined: x, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => {
      generateCalled = true;
      return { testCode: 'test("AC-1", () => {})', criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    // Modified AC text
    const stories = [
      makeStory("US-001", ["AC-1: first criterion MODIFIED", "AC-2: second criterion"]),
      makeStory("US-002", ["AC-3: third criterion"]),
    ];
    const ctx = makeCtx({ prd: makePrd(stories) as any });

    await acceptanceSetupStage.execute(ctx);

    expect(generateCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix-story exclusion: US-FIX-* stories don't affect fingerprint
// ---------------------------------------------------------------------------

describe("acceptance-setup: US-FIX-* stories excluded from fingerprint", () => {
  test("adding fix stories does NOT trigger regeneration", async () => {
    const storedFingerprint = computeACFingerprint(DEFAULT_CRITERIA);
    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: storedFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.refine = async () => [];
    _acceptanceSetupDeps.generate = async () => {
      generateCalled = true;
      return { testCode: "", criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    // PRD with original stories + a fix story added by acceptance loop
    const stories = [
      makeStory("US-001", ["AC-1: first criterion", "AC-2: second criterion"]),
      makeStory("US-002", ["AC-3: third criterion"]),
      makeStory("US-FIX-001", ["Fix the broken validation logic"]),
    ];
    const ctx = makeCtx({ prd: makePrd(stories) as any });

    await acceptanceSetupStage.execute(ctx);

    expect(generateCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P2-A: No regeneration when fingerprint matches (idempotent, AC-16)
// ---------------------------------------------------------------------------

describe("acceptance-setup: no regeneration when fingerprint unchanged (AC-16)", () => {
  test("does NOT regenerate when ACs are unchanged", async () => {
    const storedFingerprint = computeACFingerprint(DEFAULT_CRITERIA);
    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: storedFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.refine = async () => [];
    _acceptanceSetupDeps.generate = async () => {
      generateCalled = true;
      return { testCode: "", criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(generateCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P2-B: acceptance-meta.json is written after generation (AC-15)
// ---------------------------------------------------------------------------

describe("acceptance-setup: writes acceptance-meta.json (P2-B, AC-15)", () => {
  test("writes meta file after generating test (AC-15)", async () => {
    let writtenMetaPath = "";
    let writtenMeta: object | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.refine = async (c) => c.map((x) => ({ original: x, refined: x, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({ testCode: 'test("AC-1", () => {})', criteria: [] });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async (metaPath, meta) => {
      writtenMetaPath = metaPath;
      writtenMeta = meta;
    };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(writtenMetaPath).toContain("acceptance-meta.json");
    expect(writtenMeta).not.toBeNull();
  });

  test("meta contains correct fingerprint and counts (P2-B)", async () => {
    let writtenMeta: AcceptanceMeta | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.refine = async (c) => c.map((x) => ({ original: x, refined: x, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({ testCode: 'test("AC-1", () => {})', criteria: [] });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async (_path, meta) => { writtenMeta = meta; };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(writtenMeta).not.toBeNull();
    expect(writtenMeta!.acFingerprint).toBe(computeACFingerprint(DEFAULT_CRITERIA));
    expect(writtenMeta!.acCount).toBe(3);
    expect(writtenMeta!.storyCount).toBe(2);
    expect(writtenMeta!.generatedAt).toBeString();
    expect(writtenMeta!.generator).toBe("nax");
  });
});
