/**
 * Unit tests for acceptance-setup stage — pre-run autoCommitIfDirty behaviour.
 *
 * Tests cover:
 * - autoCommitIfDirty called after acceptance test file generation (issue 4/6/7)
 * - autoCommitIfDirty NOT called when fingerprint matches (no regeneration)
 * - autoCommitIfDirty receives ctx.workdir (repo root) and feature name
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "../../../../src/pipeline/stages/acceptance-setup";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { PipelineContext } from "../../../../src/pipeline/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, acs: string[]) {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria: acs,
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [makeStory("US-001", ["AC-1: login", "AC-2: logout"])];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: false, redGate: false, model: "fast" },
    } as any,
    prd: {
      project: "p",
      feature: "my-feature",
      branchName: "feat/x",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: stories,
    },
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-workdir",
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/my-feature",
    hooks: {} as any,
    ...overrides,
  };
}

/** Wire up the minimal happy-path deps for a generation run (no existing file/meta). */
function setupGenerationDeps(commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }>) {
  _acceptanceSetupDeps.fileExists = async () => false;
  _acceptanceSetupDeps.readMeta = async () => null;
  _acceptanceSetupDeps.copyFile = async () => {};
  _acceptanceSetupDeps.deleteFile = async () => {};
  _acceptanceSetupDeps.deleteSemanticVerdicts = async () => {};
  _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
    if (op.name === "acceptance-generate") return { testCode: "// generated" };
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    throw new Error(`unexpected op: ${op.name}`);
  };
  _acceptanceSetupDeps.writeFile = async () => {};
  _acceptanceSetupDeps.writeMeta = async () => {};
  _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "RED" });
  _acceptanceSetupDeps.getAgent = mock(() => null as any);
  _acceptanceSetupDeps.autoCommitIfDirty = async (workdir, stage, role, storyId) => {
    commitCalls.push({ workdir, stage, role, storyId });
  };
}

/** Wire up deps simulating a fingerprint-match (no regeneration). */
function setupFingerprintMatchDeps(
  commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }>,
  fingerprint: string,
) {
  _acceptanceSetupDeps.fileExists = async () => true;
  _acceptanceSetupDeps.readMeta = async () => ({
    generatedAt: new Date().toISOString(),
    acFingerprint: fingerprint,
    storyCount: 1,
    acCount: 2,
    generator: "nax",
  });
  _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "RED" });
  _acceptanceSetupDeps.getAgent = mock(() => null as any);
  _acceptanceSetupDeps.autoCommitIfDirty = async (workdir, stage, role, storyId) => {
    commitCalls.push({ workdir, stage, role, storyId });
  };
}

// ---------------------------------------------------------------------------
// Saved deps
// ---------------------------------------------------------------------------

let savedDeps: typeof _acceptanceSetupDeps;
beforeEach(() => { savedDeps = { ..._acceptanceSetupDeps }; });
afterEach(() => { Object.assign(_acceptanceSetupDeps, savedDeps); mock.restore(); });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acceptance-setup: autoCommitIfDirty after generation", () => {
  test("calls autoCommitIfDirty after generating acceptance test files", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = makeCtx();

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls).toHaveLength(1);
  });

  test("passes ctx.workdir to autoCommitIfDirty", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = makeCtx({ workdir: "/my/project" });

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls[0].workdir).toBe("/my/project");
  });

  test("passes feature name as storyId to autoCommitIfDirty", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = makeCtx();

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls[0].storyId).toBe("my-feature");
  });

  test("passes 'acceptance-setup' as stage to autoCommitIfDirty", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = makeCtx();

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls[0].stage).toBe("acceptance-setup");
  });

  test("passes 'pre-run' as role to autoCommitIfDirty", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = makeCtx();

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls[0].role).toBe("pre-run");
  });
});

describe("acceptance-setup: autoCommitIfDirty skipped on fingerprint match", () => {
  test("does NOT call autoCommitIfDirty when fingerprint matches (no regeneration)", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    const ctx = makeCtx();

    // Compute the real fingerprint so the stored meta matches
    const { computeACFingerprint } = await import("../../../../src/pipeline/stages/acceptance-setup");
    const acs = ctx.prd.userStories.flatMap((s) => s.acceptanceCriteria);
    const fingerprint = computeACFingerprint(acs);

    setupFingerprintMatchDeps(commitCalls, fingerprint);

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls).toHaveLength(0);
  });
});
