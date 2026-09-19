/**
 * US-004 — the story baseline section must survive from the plan-time prompt
 * bake to the dispatch-time rebuild.
 *
 * The two endpoints read their artifact coordinates from different places:
 * `assemblePlanInputsFromCtx` passes `(ctx.projectDir, ctx.prd.feature)`, while
 * the rebuild (`applyPhaseBundleToInput` → `buildForRole`) passes
 * `(ctx.packageView.repoRoot, ctx.featureName)`. They name the same artifact
 * only because `executionStage` builds the ops CallContext out of the same
 * pipeline context — a property of `src/pipeline/stages/execution.ts`, not of
 * either consumer. Drift in that construction (a renamed feature id, a
 * package-rooted view, an unset `featureName`) would silently drop the section
 * the plan-time prompt carried.
 *
 * So this seam is pinned end to end on ONE context: the prompt baked by the
 * real `assemblePlanInputsFromCtx`, and the prompt rebuilt from the CallContext
 * the real `executionStage` hands to the ops layer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  cleanupTempDir,
  DEFAULT_TEST_ROUTING,
  makeAgentAdapter,
  makeContextBundle,
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  makeTestContext,
  withExecutionDeps,
} from "@test/helpers";
import { featureDir } from "@/config";
import { _storyOrchestratorDeps, assemblePlanInputsFromCtx, ExecutionPlan } from "@/execution";
import type { CallContext } from "@/operations";
import { executionStage } from "@/pipeline";
import { writeStoryBaseline } from "@/verification";

const FEATURE = "feat-baseline-seam";
const STORY_ID = "US-001";

let tempRoot: string;

beforeEach(() => {
  tempRoot = makeTempDir("nax-test-us004-seam-");
});

afterEach(() => {
  cleanupTempDir(tempRoot);
});

describe("US-004 — baseline coordinates agree across the plan and dispatch endpoints", () => {
  test("a seeded artifact reaches both the plan-time prompt and the dispatch-time rebuild", async () => {
    await writeStoryBaseline(tempRoot, FEATURE, STORY_ID, {
      kind: "captured",
      source: "roll-forward",
      capturedAt: "2026-01-15T00:00:00.000Z",
      baseRef: "base-0001",
      entries: [{ file: "test/unit/alpha.test.ts", testName: "alpha fails" }],
    });

    const config = makeNaxConfig();
    const story = makeStory({ id: STORY_ID });
    const prd = makePRD({ feature: FEATURE, userStories: [story] });
    // The run workdir is the root both endpoints must agree on: it is where the
    // capture wrote `.nax/features/<feature>/` and what `projectDir` names.
    const runtime = makeMockRuntime({ workdir: tempRoot, config });

    const ctx = makeTestContext({
      ...makeDispatchContext({ runtime }),
      story,
      stories: [story],
      prd,
      config,
      rootConfig: config,
      routing: { ...DEFAULT_TEST_ROUTING, testStrategy: "three-session-tdd", agent: "claude" },
      projectDir: tempRoot,
      workdir: tempRoot,
      featureDir: featureDir(tempRoot, FEATURE),
      packageView: runtime.packages.repo(),
      prompt: "do the thing",
      constitution: { content: "", tokens: 0, truncated: false },
    });

    // Endpoint 1 — the prompt baked at plan time, from (projectDir, prd.feature).
    const inputs = await assemblePlanInputsFromCtx(ctx);
    const planTimeInput = inputs.implementer;
    assertDefined(planTimeInput, "inputs.implementer");
    expect(planTimeInput.promptMarkdown).toContain("# Test Baseline");
    expect(planTimeInput.promptMarkdown).toContain("test/unit/alpha.test.ts");

    // Endpoint 2 — the rebuild, from the CallContext the stage itself builds.
    let callCtx: CallContext | undefined;
    const restore = withExecutionDeps({
      getAgent: () => makeAgentAdapter({ name: "claude" }),
      validateAgentForTier: () => true,
      captureGitRef: async () => "HEAD",
      getUntrackedPaths: async () => [],
      buildPlanForStrategy: async (built: CallContext) => {
        callCtx = built;
        return new ExecutionPlan(built, {}, false);
      },
      applyPostRunInspection: async () => ({
        agentResult: {
          success: true,
          exitCode: 0,
          output: "",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
        },
        selfVerificationFailed: false,
        needsHumanReview: false,
        providerUnavailable: false,
        combinedOutput: "",
      }),
      decideStageAction: async () => ({ action: "continue" }),
    });
    try {
      await executionStage.execute(ctx);
    } finally {
      restore();
    }

    assertDefined(callCtx, "captured CallContext");
    expect(callCtx.featureName).toBe(prd.feature);
    expect(callCtx.packageView.repoRoot).toBe(ctx.projectDir);

    const rebuilt = (await _storyOrchestratorDeps.applyPhaseBundleToInput(
      "implementer",
      planTimeInput,
      makeContextBundle({ pushMarkdown: "## STAGE-BUNDLE-CONTENT" }),
      callCtx,
    )) as { promptMarkdown?: string };

    // Same artifact, both endpoints — the section is not dropped by the rebuild.
    expect(rebuilt.promptMarkdown).toContain("# Test Baseline");
    expect(rebuilt.promptMarkdown).toContain("base-0001");
    expect(rebuilt.promptMarkdown).toContain("test/unit/alpha.test.ts");
  });
});
