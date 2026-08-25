/**
 * Tests for src/bakeoff/contestant.ts
 *
 * Covers the "Provide isolated contestant execution contexts" story
 * (US-002): the pipeline dependency now receives a `ContestantRunContext`
 * (profile/config/worktree/outputDir/feature) instead of a bare `NaxConfig`,
 * and `deps` is a required third argument to `runContestant` — the mutable
 * `_contestantDeps` module default no longer exists.
 */

import { describe, expect, it, mock } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type {
  ContestantOptions,
  ContestantPipelineResult,
  ContestantRunContext,
  ContestantRunnerDeps,
} from "@/bakeoff";
import { deriveBakeoffWorktreeId, runContestant } from "@/bakeoff";
import type { ContestantResult } from "@/bakeoff/types";
import type { NaxConfig } from "@/config";

// ── Helpers ────────────────────────────────────────────────────────────────────

function baseConfig(): NaxConfig {
  return makeNaxConfig({
    agent: {
      default: "claude",
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
      },
    },
  });
}

function baseOptions(overrides: Partial<ContestantOptions> = {}): ContestantOptions {
  return {
    projectRoot: "/tmp/project",
    config: baseConfig(),
    feature: "test-feature",
    ...overrides,
  };
}

interface FakeWorktreeManager {
  create: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
  calls: {
    createArgs: Array<[string, string]>;
    removeArgs: Array<[string, string]>;
  };
}

function makeWorktreeManager(): FakeWorktreeManager {
  const createArgs: Array<[string, string]> = [];
  const removeArgs: Array<[string, string]> = [];
  return {
    create: mock(async (root: string, storyId: string) => {
      createArgs.push([root, storyId]);
    }),
    remove: mock(async (root: string, storyId: string) => {
      removeArgs.push([root, storyId]);
    }),
    calls: { createArgs, removeArgs },
  };
}

function makeDeps(overrides: Partial<ContestantRunnerDeps> = {}): ContestantRunnerDeps {
  return {
    worktreeManager: overrides.worktreeManager ?? makeWorktreeManager(),
    pipeline:
      overrides.pipeline ??
      (async () => ({
        results: [{ status: "passed" }],
        metrics: [],
      })),
  };
}

/** Runs `runContestant` while capturing the `ContestantRunContext` the pipeline received. */
async function runAndCapture(
  agent: string,
  options: ContestantOptions,
  deps: Partial<ContestantRunnerDeps> = {},
): Promise<{ result: ContestantResult; ctx: ContestantRunContext | undefined }> {
  let ctx: ContestantRunContext | undefined;
  const pipeline =
    deps.pipeline ??
    (async (c: ContestantRunContext): Promise<ContestantPipelineResult> => {
      ctx = c;
      return { results: [{ status: "passed" }], metrics: [] };
    });
  const wrappedPipeline = async (c: ContestantRunContext) => {
    ctx = c;
    return pipeline(c);
  };
  const result = await runContestant(agent, options, makeDeps({ ...deps, pipeline: wrappedPipeline }));
  return { result, ctx };
}

// ── AC-1: context.profile equals the contestant profile name ─────────────────

describe("runContestant (US-002 AC1: context.profile)", () => {
  it("US-002 AC1: context.profile equals the contestant profile name", async () => {
    const { ctx } = await runAndCapture("claude-profile", baseOptions());
    expect(ctx?.profile).toBe("claude-profile");
  });

  it("US-002 AC1 (boundary): a differently named profile is preserved verbatim on the context", async () => {
    const { ctx } = await runAndCapture("codex-profile", baseOptions());
    expect(ctx?.profile).toBe("codex-profile");
  });
});

// ── AC-2: context.feature equals the bake-off feature ─────────────────────────

describe("runContestant (US-002 AC2: context.feature)", () => {
  it("US-002 AC2: context.feature equals the bake-off feature", async () => {
    const { ctx } = await runAndCapture("claude", baseOptions({ feature: "inline-charts" }));
    expect(ctx?.feature).toBe("inline-charts");
  });

  it("US-002 AC2 (boundary): a different feature value is preserved verbatim, not defaulted", async () => {
    const { ctx } = await runAndCapture("claude", baseOptions({ feature: "another-feature" }));
    expect(ctx?.feature).toBe("another-feature");
  });
});

// ── AC-3: context.worktree ends with the contestant worktree ID ──────────────

describe("runContestant (US-002 AC3: context.worktree)", () => {
  it("US-002 AC3: context.worktree path ends with the feature+profile-derived worktree ID", async () => {
    const { ctx } = await runAndCapture("claude", baseOptions({ feature: "test-feature" }));
    const expectedId = deriveBakeoffWorktreeId("test-feature", "claude");
    expect(ctx?.worktree.endsWith(expectedId)).toBe(true);
  });

  it("US-002 AC3 (boundary): a different profile changes the trailing worktree ID accordingly", async () => {
    const { ctx } = await runAndCapture("codex", baseOptions({ feature: "test-feature" }));
    const expectedId = deriveBakeoffWorktreeId("test-feature", "codex");
    expect(ctx?.worktree.endsWith(expectedId)).toBe(true);
  });

  // US-004: worktree IDs are derived from feature+profile, not profile alone —
  // two contestants sharing a profile across different features must get
  // distinct worktree IDs (deriveBakeoffWorktreeId(feature, profile)).
  it("US-004: a different feature changes the trailing worktree ID even for the same profile", async () => {
    const { ctx: ctxA } = await runAndCapture("claude", baseOptions({ feature: "feature-a" }));
    const { ctx: ctxB } = await runAndCapture("claude", baseOptions({ feature: "feature-b" }));

    const expectedA = deriveBakeoffWorktreeId("feature-a", "claude");
    const expectedB = deriveBakeoffWorktreeId("feature-b", "claude");

    expect(ctxA?.worktree.endsWith(expectedA)).toBe(true);
    expect(ctxB?.worktree.endsWith(expectedB)).toBe(true);
    expect(ctxA?.worktree).not.toBe(ctxB?.worktree);
  });
});

// ── AC-5: context.outputDir equals project root + bakeoff/<feature>/<profile> ─

describe("runContestant (US-002 AC5: context.outputDir)", () => {
  it("US-002 AC5: context.outputDir equals the project output root joined with bakeoff, the feature, and the profile name", async () => {
    const { ctx } = await runAndCapture(
      "claude",
      baseOptions({ feature: "inline-charts", outputDir: "/tmp/project-output" }),
    );
    const expected = ["/tmp/project-output", "bakeoff", "inline-charts", "claude"].join("/");
    expect(ctx?.outputDir).toBe(expected);
  });

  it("US-002 AC5 (boundary): a different profile/feature pair changes the derived outputDir accordingly", async () => {
    const { ctx } = await runAndCapture("codex", baseOptions({ feature: "other-feature", outputDir: "/tmp/root" }));
    const expected = ["/tmp/root", "bakeoff", "other-feature", "codex"].join("/");
    expect(ctx?.outputDir).toBe(expected);
  });
});

// ── AC-7: context.config.outputDir equals context.outputDir ──────────────────

describe("runContestant (US-002 AC7: config.outputDir mirrors context.outputDir)", () => {
  it("US-002 AC7: context.config.outputDir equals context.outputDir", async () => {
    const { ctx } = await runAndCapture(
      "claude",
      baseOptions({ feature: "inline-charts", outputDir: "/tmp/project-output" }),
    );
    expect(ctx?.config.outputDir).toBe(ctx?.outputDir);
  });

  it("US-002 AC7 (boundary): still holds when the base config already declared an unrelated outputDir override", async () => {
    const config = { ...baseConfig(), outputDir: "/some/unrelated/path" };
    const { ctx } = await runAndCapture("claude", baseOptions({ config, outputDir: "/tmp/project-output" }));
    expect(ctx?.config.outputDir).toBe(ctx?.outputDir);
  });
});

// ── AC-8: pipeline dependency rejects → status 'dnf-crashed' ─────────────────

describe("runContestant (US-002 AC8: pipeline crash classification)", () => {
  it("US-002 AC8: returns status 'dnf-crashed' with a non-empty error and does not re-throw", async () => {
    const wt = makeWorktreeManager();
    const pipeline = mock(async () => {
      throw new Error("kaboom");
    });

    let result: ContestantResult | unknown;
    let didThrow = false;
    try {
      result = await runContestant("claude", baseOptions(), makeDeps({ worktreeManager: wt, pipeline }));
    } catch (err) {
      didThrow = true;
      result = err;
    }

    expect(didThrow).toBe(false);
    expect((result as ContestantResult).status).toBe("dnf-crashed");
    expect(typeof (result as ContestantResult).error).toBe("string");
    expect(((result as ContestantResult).error as string).length).toBeGreaterThan(0);
  });

  it("US-002 AC8 (boundary): non-Error throws are stringified into the error field", async () => {
    const pipeline = mock(async () => {
      throw "string-only failure";
    });

    const result = await runContestant("claude", baseOptions(), makeDeps({ pipeline }));

    expect(result.status).toBe("dnf-crashed");
    expect(typeof result.error).toBe("string");
    expect((result.error as string).length).toBeGreaterThan(0);
  });
});

// ── Worktree lifecycle still runs create-before / remove-after around the pipeline ──

describe("runContestant (worktree lifecycle around the pipeline)", () => {
  it("calls worktree.create BEFORE the pipeline and worktree.remove AFTER, even when the pipeline throws", async () => {
    const order: string[] = [];
    const wt: FakeWorktreeManager = {
      calls: { createArgs: [], removeArgs: [] },
      create: mock(async (root: string, storyId: string) => {
        order.push("create");
        wt.calls.createArgs.push([root, storyId]);
      }),
      remove: mock(async (root: string, storyId: string) => {
        order.push("remove");
        wt.calls.removeArgs.push([root, storyId]);
      }),
    };
    const pipeline = mock(async () => {
      order.push("pipeline");
      throw new Error("pipeline exploded");
    });

    await runContestant("claude", baseOptions(), makeDeps({ worktreeManager: wt, pipeline }));

    expect(order).toEqual(["create", "pipeline", "remove"]);
  });

  it("does not throw when worktreeManager.create rejects — returns dnf-crashed instead (BUG-03)", async () => {
    const wt = makeWorktreeManager();
    wt.create = mock(async () => {
      throw new Error("worktree create failed");
    });
    const pipeline = mock(async () => {
      throw new Error("should never be called");
    });

    const result = await runContestant("claude", baseOptions(), makeDeps({ worktreeManager: wt, pipeline }));

    expect(result.status).toBe("dnf-crashed");
    expect(result.error as string).toContain("worktree create failed");
    expect(pipeline).not.toHaveBeenCalled();
  });
});

// ── Pinned config preserves the resolved agent.default and forces fallback off ──

describe("runContestant (pinned config delivered via context.config)", () => {
  it("preserves the profile-resolved agent.default from options.config (does not overwrite it with the raw profile name) and forces agent.fallback.enabled === false", async () => {
    // options.config.agent.default ("claude") is already the resolved agent —
    // set upstream by preflight's buildContestantConfig from the profile
    // overlay. The contestant argument ("gpu-claude-profile") is a *profile*
    // name (ContestantRunContext.profile), which can differ from the agent it
    // resolves to, so it must never stomp the already-resolved default.
    const { ctx } = await runAndCapture("gpu-claude-profile", baseOptions({ config: baseConfig() }));
    expect(ctx?.config.agent?.default).toBe("claude");
    expect(ctx?.config.agent?.fallback?.enabled).toBe(false);
  });

  it("(boundary) a differently named profile still leaves agent.default untouched, proving it is not derived from the profile argument", async () => {
    const { ctx } = await runAndCapture("some-other-profile-name", baseOptions({ config: baseConfig() }));
    expect(ctx?.config.agent?.default).toBe("claude");
    expect(ctx?.config.agent?.fallback?.enabled).toBe(false);
  });
});

// ── Status classification + metrics aggregation unaffected by the context change ──

describe("runContestant (status classification + metrics aggregation)", () => {
  it("returns status 'passed' with storiesPassed === storiesTotal when every story succeeds", async () => {
    const pipeline = mock(
      async (): Promise<ContestantPipelineResult> => ({
        results: [{ status: "passed" }, { status: "passed" }, { status: "passed" }],
        metrics: [],
      }),
    );

    const result = await runContestant("claude", baseOptions({ storiesTotal: 3 }), makeDeps({ pipeline }));

    expect(result.status).toBe("passed");
    expect(result.storiesTotal).toBe(3);
    expect(result.storiesPassed).toBe(3);
  });

  it("returns status 'failed' when at least one story is unpassed", async () => {
    const pipeline = mock(
      async (): Promise<ContestantPipelineResult> => ({
        results: [{ status: "passed" }, { status: "failed" }],
        metrics: [],
      }),
    );

    const result = await runContestant("claude", baseOptions({ storiesTotal: 2 }), makeDeps({ pipeline }));

    expect(result.status).toBe("failed");
    expect(result.storiesPassed).toBe(1);
  });

  it("returns status 'cost-limit' when the pipeline signals a per-contestant cost-limit abort", async () => {
    const pipeline = mock(
      async (): Promise<ContestantPipelineResult> => ({
        results: [],
        metrics: [],
        costLimitReached: true,
      }),
    );

    const result = await runContestant("claude", baseOptions({ maxCostUsd: 5 }), makeDeps({ pipeline }));

    expect(result.status).toBe("cost-limit");
  });

  it("returns status 'timeout' when the pipeline signals a bounds-exhausted outcome without passing", async () => {
    const pipeline = mock(
      async (): Promise<ContestantPipelineResult> => ({
        results: [],
        metrics: [],
        status: "timeout",
      }),
    );

    const result = await runContestant("claude", baseOptions(), makeDeps({ pipeline }));

    expect(result.status).toBe("timeout");
  });

  it("maps total cost -> costUsd, total durationMs -> wallTimeMs, attempts -> tierEscalations", async () => {
    const pipeline = mock(
      async (): Promise<ContestantPipelineResult> => ({
        results: [{ status: "passed" }, { status: "passed" }],
        metrics: [
          { cost: 100, durationMs: 5000, attempts: 1 },
          { cost: 200, durationMs: 3000, attempts: 3 },
        ],
      }),
    );

    const result = await runContestant("claude", baseOptions({ storiesTotal: 2 }), makeDeps({ pipeline }));

    expect(result.costUsd).toBe(300);
    expect(result.wallTimeMs).toBe(8000);
    expect(result.tierEscalations).toBeGreaterThanOrEqual(0);
  });
});
