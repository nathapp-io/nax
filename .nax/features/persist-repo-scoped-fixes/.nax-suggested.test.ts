import { describe, expect, test } from "bun:test";
import { recordRepoScopedFixes } from "../../../src/execution";
import { _executionDeps, executionStage } from "../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../src/pipeline/types";
import { makeAgentAdapter, makeNaxConfig, makeTestContext, makeTestStory } from "../../../test/helpers";

describe("persist-repo-scoped-fixes acceptance", () => {
  test("AC-1: empty and undefined records preserve existing repo-scoped fixes", () => {
    const existingFix = {
      triggeringTests: ["test/legacy/auth.test.ts::redirects to login"],
      filesChanged: ["src/legacy/auth.ts"],
      findingsCleared: true,
    };
    const story = makeTestStory({ repoScopedFixes: [existingFix] });
    const originalFixes = story.repoScopedFixes;

    recordRepoScopedFixes(story, []);

    expect(story.repoScopedFixes).toBe(originalFixes);
    expect(story.repoScopedFixes).toHaveLength(1);
    expect(story.repoScopedFixes?.[0]).toBe(existingFix);

    recordRepoScopedFixes(story, undefined);

    expect(story.repoScopedFixes).toBe(originalFixes);
    expect(story.repoScopedFixes).toHaveLength(1);
    expect(story.repoScopedFixes?.[0]).toBe(existingFix);
  });

  test("AC-2: a plan failure does not invoke the recorder or mutate existing repo-scoped fixes", async () => {
    const config = makeNaxConfig();
    const existingFix = {
      triggeringTests: ["test/legacy/auth.test.ts::redirects to login"],
      filesChanged: ["src/legacy/auth.ts"],
      findingsCleared: true,
    };
    const story = makeTestStory({ id: "US-persist-failure", repoScopedFixes: [existingFix] });
    const originalFixes = story.repoScopedFixes;
    const ctx = makeTestContext({
      config,
      story,
      workdir: "/tmp/nax-persist-repo-scoped-fixes",
      routing: { modelTier: "fast", testStrategy: "test-after", agent: "claude", complexity: "simple", reasoning: "" },
      packageView: { select: () => config } as PipelineContext["packageView"],
      runtime: {
        dispatchEvents: { onDispatch: () => () => {} },
        signal: undefined,
        packages: undefined,
        onPidSpawned: undefined,
      } as PipelineContext["runtime"],
    });
    type Recorder = typeof _executionDeps.recordRepoScopedFixes;
    type RecorderSpy = Recorder & { calls: Parameters<Recorder>[] };
    const recorded: RecorderSpy = Object.assign(
      (...args: Parameters<Recorder>) => {
        recorded.calls.push(args);
      },
      { calls: [] as Parameters<Recorder>[] },
    );
    const savedDeps = { ..._executionDeps };
    const planFailure = new Error("plan failed");

    _executionDeps.getAgent = () => makeAgentAdapter({ name: "claude" });
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.assemblePlanInputsFromCtx = async () => ({}) as never;
    _executionDeps.buildPlanForStrategy = async () =>
      ({
        run: async () => {
          throw planFailure;
        },
      }) as never;
    _executionDeps.recordRepoScopedFixes = recorded as typeof _executionDeps.recordRepoScopedFixes;

    try {
      await expect(executionStage.execute(ctx)).rejects.toBe(planFailure);
      expect(recorded.calls.length).toBe(0);
    } finally {
      Object.assign(_executionDeps, savedDeps);
    }

    expect(story.repoScopedFixes).toBe(originalFixes);
    expect(story.repoScopedFixes).toHaveLength(1);
    expect(story.repoScopedFixes?.[0]).toBe(existingFix);
  });
});