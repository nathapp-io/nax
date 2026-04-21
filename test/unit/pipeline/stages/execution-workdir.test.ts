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
import { DEFAULT_CONFIG } from "../../../../src/config";
import { makeAgentAdapter, makeNaxConfig, makeStory } from "../../../../test/helpers";

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

afterEach(() => {
  mock.restore();
  _executionDeps.getAgent = originalGetAgent;
  _executionDeps.validateAgentForTier = originalValidateAgentForTier;
  _executionDeps.detectMergeConflict = originalDetectMergeConflict;
});

function makeCtx(storyOverrides: Partial<UserStory> = {}): PipelineContext {
  const story = makeStory(storyOverrides);
  return {
    config: makeNaxConfig(),
    prd: { project: "p", feature: "f", branchName: "b", createdAt: "", updatedAt: "", userStories: [story] } as PRD,
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/repo",
    projectDir: "/repo",
    hooks: {},
    prompt: "Do the thing",
  } as unknown as PipelineContext;
}

test("execution stage passes repoRoot workdir when story.workdir is undefined", async () => {
  let capturedWorkdir: string | undefined;

  _executionDeps.getAgent = () =>
    makeAgentAdapter({
      name: "claude",
      capabilities: { supportedTiers: ["fast"] },
      run: async (opts: { workdir: string }) => {
        capturedWorkdir = opts.workdir;
        return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 };
      },
    });

  _executionDeps.validateAgentForTier = () => true;
  _executionDeps.detectMergeConflict = () => false;

  const ctx = makeCtx();
  await executionStage.execute(ctx);

  expect(capturedWorkdir).toBe("/repo");
});

test("execution stage passes resolved package workdir when story.workdir is set", async () => {
  let capturedWorkdir: string | undefined;

  _executionDeps.getAgent = () =>
    makeAgentAdapter({
      name: "claude",
      capabilities: { supportedTiers: ["fast"] },
      run: async (opts: { workdir: string }) => {
        capturedWorkdir = opts.workdir;
        return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 };
      },
    });

  _executionDeps.validateAgentForTier = () => true;
  _executionDeps.detectMergeConflict = () => false;

  // workdir is resolved at context creation (Phase 3) — pass already-resolved path
  const story = makeStory({ workdir: "packages/api" });
  const ctx: PipelineContext = {
    ...makeCtx(),
    story,
    workdir: join("/repo", "packages/api"),
  };
  await executionStage.execute(ctx);

  expect(capturedWorkdir).toBe(join("/repo", "packages/api"));
});
