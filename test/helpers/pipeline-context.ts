/**
 * Centralized PipelineContext factory for tests.
 *
 * Provides sensible defaults so test files only override the fields
 * they care about. Eliminates the per-file makeCtx() boilerplate.
 *
 * Usage:
 * ```ts
 * import { makeTestContext, makeTestStory, makeTestPRD } from "../../helpers/pipeline-context";
 *
 * const ctx = makeTestContext({ workdir: "/tmp/mytest" });
 * const ctx = makeTestContext({
 *   config: { ...DEFAULT_CONFIG, review: { enabled: true, checks: ["lint"], commands: {} } },
 * });
 * ```
 */

import { DEFAULT_CONFIG } from "../../src/config";
import type { PipelineContext, RoutingResult } from "../../src/pipeline/types";
import type { PRD, UserStory } from "../../src/prd/types";

export const DEFAULT_TEST_ROUTING: RoutingResult = {
  complexity: "simple",
  modelTier: "fast",
  testStrategy: "test-after",
  reasoning: "",
};

export function makeTestStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Test story",
    description: "A test story",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

export function makeTestPRD(stories?: UserStory[]): PRD {
  const defaultStory = makeTestStory();
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories ?? [defaultStory],
  } as unknown as PRD;
}

/**
 * Build a PipelineContext with sensible defaults.
 * Override only what your test actually needs.
 */
export function makeTestContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const story = overrides.story ?? makeTestStory();
  const prd = overrides.prd ?? makeTestPRD([story]);

  return {
    config: DEFAULT_CONFIG,
    effectiveConfig: DEFAULT_CONFIG,
    prd,
    story,
    stories: [story],
    routing: DEFAULT_TEST_ROUTING,
    workdir: "/tmp/nax-test",
    hooks: { hooks: {} },
    ...overrides,
  } as PipelineContext;
}
