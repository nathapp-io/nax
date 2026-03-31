/**
 * Unit tests for execution stage workdir resolution (MW-002)
 *
 * Verifies that resolveStoryWorkdir correctly computes the effective working
 * directory for a story, and that the execution stage passes the resolved
 * workdir to agent.run() when story.workdir is set.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { _executionDeps, executionStage, resolveStoryWorkdir } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import type { NaxConfig } from "../../../../src/config";

// ─────────────────────────────────────────────────────────────────────────────
// resolveStoryWorkdir — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveStoryWorkdir (MW-002)", () => {
  test("returns repoRoot unchanged when storyWorkdir is undefined", () => {
    expect(resolveStoryWorkdir("/tmp")).toBe("/tmp");
  });

  test("returns repoRoot unchanged when storyWorkdir is empty string", () => {
    expect(resolveStoryWorkdir("/tmp", "")).toBe("/tmp");
  });

  test("joins repoRoot with storyWorkdir when directory exists", () => {
    // /tmp always exists — use it as the package dir
    expect(resolveStoryWorkdir("/", "tmp")).toBe("/tmp");
  });

  test("throws when storyWorkdir does not exist on disk", () => {
    expect(() => resolveStoryWorkdir("/tmp", "nonexistent-package-xyz")).toThrow(
      'story.workdir "nonexistent-package-xyz" does not exist',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executionStage — workdir passed to agent.run()
// ─────────────────────────────────────────────────────────────────────────────

const originalGetAgent = _executionDeps.getAgent;
const originalValidateAgentForTier = _executionDeps.validateAgentForTier;
const originalDetectMergeConflict = _executionDeps.detectMergeConflict;
const originalAutoCommitIfDirty = _executionDeps.resolveStoryWorkdir;

afterEach(() => {
  mock.restore();
  _executionDeps.getAgent = originalGetAgent;
  _executionDeps.validateAgentForTier = originalValidateAgentForTier;
  _executionDeps.detectMergeConflict = originalDetectMergeConflict;
  _executionDeps.resolveStoryWorkdir = originalAutoCommitIfDirty;
});

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Test story",
    description: "desc",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    attempts: 1,
    escalations: [],
    ...overrides,
  };
}

function makeConfig(): NaxConfig {
  return {
    autoMode: { defaultAgent: "claude" },
    execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60 },
    models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    quality: { requireTests: false, commands: { test: "bun test" } },
    agent: {},
  } as unknown as NaxConfig;
}

function makeCtx(storyOverrides: Partial<UserStory> = {}): PipelineContext {
  const story = makeStory(storyOverrides);
  return {
    config: makeConfig(),
    prd: { project: "p", feature: "f", branchName: "b", createdAt: "", updatedAt: "", userStories: [story] } as PRD,
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/repo",
    hooks: {},
    prompt: "Do the thing",
  } as unknown as PipelineContext;
}

test("execution stage passes repoRoot workdir when story.workdir is undefined", async () => {
  let capturedWorkdir: string | undefined;

  _executionDeps.getAgent = () =>
    ({
      name: "claude",
      capabilities: { supportedTiers: ["fast"] },
      run: async (opts: { workdir: string }) => {
        capturedWorkdir = opts.workdir;
        return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 };
      },
    }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

  _executionDeps.validateAgentForTier = () => true;
  _executionDeps.detectMergeConflict = () => false;

  const ctx = makeCtx();
  await executionStage.execute(ctx);

  expect(capturedWorkdir).toBe("/repo");
});

test("execution stage passes resolved package workdir when story.workdir is set", async () => {
  let capturedWorkdir: string | undefined;

  _executionDeps.getAgent = () =>
    ({
      name: "claude",
      capabilities: { supportedTiers: ["fast"] },
      run: async (opts: { workdir: string }) => {
        capturedWorkdir = opts.workdir;
        return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 };
      },
    }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

  _executionDeps.validateAgentForTier = () => true;
  _executionDeps.detectMergeConflict = () => false;
  // Mock resolveStoryWorkdir to avoid filesystem check in unit test
  _executionDeps.resolveStoryWorkdir = (root: string, pkg?: string) =>
    pkg ? join(root, pkg) : root;

  const ctx = makeCtx({ workdir: "packages/api" });
  await executionStage.execute(ctx);

  expect(capturedWorkdir).toBe(join("/repo", "packages/api"));
});
