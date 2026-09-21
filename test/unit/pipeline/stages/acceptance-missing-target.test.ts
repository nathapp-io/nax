/**
 * Unit tests for US-003: fail acceptance when a required target is missing.
 *
 * Covers AC-1 through AC-9 of the story spec — the consumer-side predicate that
 * turns a missing acceptance test file into a hard fail when the group has PRD
 * stories and acceptance is enabled for the package.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeDispatchContext, makePRD, makeSpawn, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { acceptanceStage } from "@/pipeline/stages";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "@/pipeline/stages/acceptance-setup";
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
    },
    rootConfig: DEFAULT_CONFIG,
    prd: {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: stories,
    },
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp/test-workdir",
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: { hooks: {} },
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
  Object.assign(Bun, {
    file: (p: string) => ({
      exists: () => Promise.resolve(presentPaths.has(p)),
      text: () => Promise.resolve(""),
    }),
  });
  return () => {
    Object.assign(Bun, { file: origFile });
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
        },
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
      },
    });
    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });

  test("AC-9: every group present and passing → continue", async () => {
    const present = new Set(["/tmp/a.test.ts", "/tmp/b.test.ts"]);
    const restoreFile = stubFileExists(present);
    const origSpawn = _executorDeps.spawn;
    _executorDeps.spawn = makeSpawn(() => ({
      exitCode: 0,
      stdout: "1 pass\n",
    })).spawn;
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
    _executorDeps.spawn = makeSpawn(() => ({
      exitCode: 1,
      stdout: "  (fail) AC-2: present boom\n",
    })).spawn;
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

// ---------------------------------------------------------------------------
// Absorbed: acceptance-setup-agent-file.test.ts
// ---------------------------------------------------------------------------

function agentFileMakeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const prd = makePRD({
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    userStories: [makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: const name declared", "AC-2: tests pass"] })],
  });
  const stories = prd.userStories;
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
    },
    prd,
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-agent-file",
    projectDir: "/tmp/test-agent-file",
    featureDir: "/tmp/test-agent-file/.nax/features/test-feature",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
    ...overrides,
  };
}

// Real acceptance test content (has import + describe → extractTestCode matches).
const REAL_ACCEPTANCE_TEST = `import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";

describe("test-feature - Acceptance Tests", () => {
  test("AC-1: const name declared", async () => {
    const src = readFileSync(join(import.meta.dir, "../../../src/greeting.ts"), "utf8");
    expect(src).toMatch(/const name\\s*=/);
  });

  test("AC-2: tests pass", async () => {
    const result = spawnSync(["bun", "test", "src/greeting.test.ts"], { cwd: join(import.meta.dir, "../../..") });
    expect(result.exitCode).toBe(0);
  });
});
`;

// Bare test content recovered by verify Tier-2 (has test() calls, no import{}/describe()).
const BARE_TIER2_TEST = `test("AC-1: const name declared", () => {
  expect(true).toBe(true); // real assertion placeholder
});

test("AC-2: tests pass", () => {
  expect(2 + 2).toBe(4);
});
`;

// Non-test conversational output — verify hook returns null for this.
const NON_TEST_CONTENT =
  "The acceptance tests have been written. Please verify that the implementation satisfies all the criteria.";

let agentFileSavedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  agentFileSavedDeps = { ..._acceptanceSetupDeps };
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, agentFileSavedDeps);
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helper: wire deps so callOp returns the given testCode for acceptance-generate.
// No disk-reading needed — recovery now lives inside callOp/verify (ADR-020 Wave 3).
// ---------------------------------------------------------------------------

function makeCallOpDeps(writtenFiles: Array<{ path: string; content: string }>, testCodeResult: string | null) {
  _acceptanceSetupDeps.readMeta = async () => null;
  _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") return { testCode: testCodeResult };
    throw new Error(`unexpected op: ${op.name}`);
  };
  // fileExists used only by fingerprint pre-backup guard (returns false → no pre-gen backup).
  _acceptanceSetupDeps.fileExists = async () => false;
  _acceptanceSetupDeps.writeFile = async (p, c) => {
    writtenFiles.push({ path: p, content: c });
  };
  _acceptanceSetupDeps.writeMeta = async () => {};
  _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
  _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
}

describe("acceptance-setup: ACP agent-written file handling (ADR-020 Wave 3)", () => {
  test("forwards the loader-resolved package config to refinement and generation", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    const packageConfig = {
      ...DEFAULT_CONFIG,
      execution: { ...DEFAULT_CONFIG.execution, permissionProfile: "safe" as const },
    };
    const seen: Array<{ packageDir: string; permissionProfile: string | undefined }> = [];
    makeCallOpDeps(writtenFiles, REAL_ACCEPTANCE_TEST);
    const originalCallOp = _acceptanceSetupDeps.callOp;
    _acceptanceSetupDeps.loadGroupConfig = async () => packageConfig;
    _acceptanceSetupDeps.callOp = async (ctx, packageDir, op, input, storyId, config) => {
      seen.push({ packageDir, permissionProfile: config?.execution?.permissionProfile });
      return originalCallOp(ctx, packageDir, op, input, storyId, config);
    };
    const story = makeStory({ id: "US-001", workdir: "apps/web", acceptanceCriteria: ["AC-1: package config"] });
    const prd = makePRD({ feature: "test-feature", userStories: [story] });

    await acceptanceSetupStage.execute(
      agentFileMakeCtx({
        prd,
        story,
        stories: [story],
        workdir: "/repo",
        projectDir: "/repo",
        featureDir: "/repo/.nax/features/test-feature",
        config: { ...packageConfig, acceptance: { ...packageConfig.acceptance, refinement: true } },
      }),
    );

    expect(seen).toEqual([
      { packageDir: "/repo/apps/web", permissionProfile: "safe" },
      { packageDir: "/repo/apps/web", permissionProfile: "safe" },
    ]);
  });

  test("callOp returns real test code (verify extracted it); written directly, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    // Simulate: verify hook extracted code from agent-written file and returned it via callOp.
    makeCallOpDeps(writtenFiles, REAL_ACCEPTANCE_TEST);

    await acceptanceSetupStage.execute(agentFileMakeCtx());

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    // Content is the real acceptance test, not a skeleton placeholder.
    const firstWrite = testFileWrites[0];
    assertDefined(firstWrite, "testFileWrites[0]");
    expect(firstWrite.content).toContain("const name\\s*=");
    expect(firstWrite.content).not.toContain("expect(true).toBe(false)");

    // No .llm-recovery.bak — backup is not done at stage level.
    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(0);
  });

  test("callOp returns bare test file (verify tier-2 recovery); written directly, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    // Simulate: verify hook found bare test content (Tier-2) and returned it via callOp.
    makeCallOpDeps(writtenFiles, BARE_TIER2_TEST);

    await acceptanceSetupStage.execute(agentFileMakeCtx());

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    const bareWrite = testFileWrites[0];
    assertDefined(bareWrite, "testFileWrites[0]");
    expect(bareWrite.content).toBe(BARE_TIER2_TEST);

    // No backup at stage level — backup was stage-side behavior removed in ADR-020 Wave 3.
    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(0);
  });

  test("callOp returns null (verify exhausted, non-test content); skeleton written, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    // Simulate: verify hook found non-test content and returned null → callOp returns null.
    makeCallOpDeps(writtenFiles, null);
    // readFile would return NON_TEST_CONTENT but stage no longer reads disk after callOp.
    void NON_TEST_CONTENT;

    await acceptanceSetupStage.execute(agentFileMakeCtx());

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    const skeletonWrite = testFileWrites[0];
    assertDefined(skeletonWrite, "testFileWrites[0]");
    expect(skeletonWrite.content).toContain("expect(true).toBe(false)");

    // No backup at stage level.
    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(0);
  });

  test("callOp returns null (file never written by agent); skeleton written, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    makeCallOpDeps(writtenFiles, null);

    await acceptanceSetupStage.execute(agentFileMakeCtx());

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    const skeletonWrite2 = testFileWrites[0];
    assertDefined(skeletonWrite2, "testFileWrites[0]");
    expect(skeletonWrite2.content).toContain("expect(true).toBe(false)");

    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(0);
  });

  test("normal path — callOp returns real testCode; written directly, no recovery", async () => {
    const writtenContents: string[] = [];

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") return { testCode: REAL_ACCEPTANCE_TEST };
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async (_p, c) => {
      writtenContents.push(c);
    };
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(agentFileMakeCtx());

    // testCode is set from callOp — written as-is, no skeleton substitution
    const testContentWrites = writtenContents.filter((c) => c.includes("describe(") || c.includes("test("));
    expect(testContentWrites.some((c) => c.includes("const name\\s*="))).toBe(true);
    expect(testContentWrites.every((c) => !c.includes("expect(true).toBe(false)"))).toBe(true);
  });
});
