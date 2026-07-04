/**
 * Tests for src/bakeoff/contestant.ts
 *
 * Covers AC-1 through AC-9 of the "Pinned contestant runner and worktree
 * isolation" story.
 */

import { describe, expect, it, mock } from "bun:test";
import { type ContestantOptions, type ContestantPipelineResult, _contestantDeps, runContestant } from "@/bakeoff";
import type { ContestantResult } from "@/bakeoff/types";
import type { NaxConfig } from "@/config";
import type { StoryMetrics } from "@/metrics";
import type { WorktreeManager } from "@/worktree/manager";

// ── Helpers ────────────────────────────────────────────────────────────────────

function baseConfig(): NaxConfig {
  return {
    agent: {
      default: "claude",
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
      },
    },
  } as unknown as NaxConfig;
}

function baseOptions(overrides: Partial<ContestantOptions> = {}): ContestantOptions {
  return {
    name: "test-contestant",
    projectRoot: "/tmp/project",
    storyId: "story-1",
    config: baseConfig(),
    ...overrides,
  };
}

function makeStoryMetrics(overrides: Partial<StoryMetrics> = {}): StoryMetrics {
  return {
    storyId: "story-1",
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-sonnet",
    agentUsed: "claude",
    attempts: 1,
    finalTier: "balanced",
    success: true,
    cost: 0,
    durationMs: 0,
    firstPassSuccess: true,
    startedAt: "2026-07-04T00:00:00.000Z",
    completedAt: "2026-07-04T00:00:01.000Z",
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

interface FakePipeline {
  fn: ReturnType<typeof mock>;
  callOrder: string[];
}

function makePipeline(
  impl: (opts: ContestantOptions & { config: NaxConfig }) => Promise<ContestantPipelineResult>,
  callOrder?: string[],
): FakePipeline {
  return {
    fn: mock(async (opts: ContestantOptions & { config: NaxConfig }) => {
      callOrder?.push("pipeline");
      return impl(opts);
    }),
    callOrder: callOrder ?? [],
  };
}

/**
 * Replace `_contestantDeps` with the supplied deps for one call, then restore.
 */
function withDeps<T>(overrides: Partial<typeof _contestantDeps>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = (_contestantDeps as Record<string, unknown>)[key];
  }
  Object.assign(_contestantDeps, overrides);
  return fn().finally(() => {
    for (const key of Object.keys(saved)) {
      (_contestantDeps as Record<string, unknown>)[key] = saved[key];
    }
  });
}

// ── AC-1: Result.agent equals requested agent name ─────────────────────────────

describe("runContestant (AC-1: agent identity)", () => {
  it("AC1: returns a ContestantResult whose agent equals the requested agent name (claude)", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [makeStoryMetrics({ success: true })],
      storiesTotal: 1,
      outcome: { kind: "passed" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.agent).toBe("claude");
    expect(result.name).toBe("test-contestant");
  });

  // Boundary: a different contestant name is preserved verbatim, not normalised.
  it("AC1 (boundary): preserves a non-default agent name (codex) verbatim on the result", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [makeStoryMetrics({ success: true, agentUsed: "codex" })],
      storiesTotal: 1,
      outcome: { kind: "passed" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("codex", baseOptions()),
    );

    expect(result.agent).toBe("codex");
  });
});

// ── AC-2: Worktree lifecycle on pipeline throw ────────────────────────────────

describe("runContestant (AC-2: worktree lifecycle on pipeline throw)", () => {
  it("AC2: calls worktree.create BEFORE the pipeline and worktree.remove AFTER", async () => {
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
    const pipeline: FakePipeline = {
      fn: mock(async () => {
        order.push("pipeline");
        throw new Error("pipeline exploded");
      }),
      callOrder: order,
    };

    await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      async () => {
        await runContestant("claude", baseOptions());
      },
    );

    expect(order).toEqual(["create", "pipeline", "remove"]);
    expect(wt.calls.createArgs).toEqual([["/tmp/project", "story-1"]]);
    expect(wt.calls.removeArgs).toEqual([["/tmp/project", "story-1"]]);
  });

  // Boundary: even when the pipeline throws synchronously, the remove is still issued.
  it("AC2 (boundary): still calls worktree.remove when pipeline throws synchronously", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(() => {
      throw new Error("sync boom");
    });

    await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      async () => {
        await runContestant("claude", baseOptions());
      },
    );

    expect(wt.create.mock.calls).toHaveLength(1);
    expect(wt.remove.mock.calls).toHaveLength(1);
  });
});

// ── AC-3: Pipeline receives pinned config ─────────────────────────────────────

describe("runContestant (AC-3: pinned config delivery to pipeline)", () => {
  it("AC3: delivers a config where agent.default === contestant name and agent.fallback.enabled === false", async () => {
    const wt = makeWorktreeManager();
    let capturedConfig: NaxConfig | undefined;
    const pipeline = makePipeline(async (opts) => {
      capturedConfig = opts.config;
      return {
        storyMetrics: [makeStoryMetrics({ success: true })],
        storiesTotal: 1,
        outcome: { kind: "passed" },
      };
    });

    await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("codex", baseOptions()),
    );

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig?.agent?.default).toBe("codex");
    expect(capturedConfig?.agent?.fallback?.enabled).toBe(false);
  });

  // Boundary: even if base config had fallback ENABLED, the runner forces it off.
  it("AC3 (boundary): forces fallback.enabled=false even when base config had fallback ENABLED", async () => {
    const wt = makeWorktreeManager();
    let capturedConfig: NaxConfig | undefined;
    const pipeline = makePipeline(async (opts) => {
      capturedConfig = opts.config;
      return {
        storyMetrics: [makeStoryMetrics({ success: true })],
        storiesTotal: 1,
        outcome: { kind: "passed" },
      };
    });

    const baseWithFallback = baseConfig();
    baseWithFallback.agent = {
      ...baseWithFallback.agent,
      fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 3 },
    };

    await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions({ config: baseWithFallback })),
    );

    expect(capturedConfig?.agent?.default).toBe("claude");
    expect(capturedConfig?.agent?.fallback?.enabled).toBe(false);
  });
});

// ── AC-4: All stories pass → status "passed", storiesPassed === storiesTotal ──

describe("runContestant (AC-4: full pass classification)", () => {
  it("AC4: returns status 'passed' with storiesPassed === storiesTotal when every story succeeds", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [
        makeStoryMetrics({ storyId: "story-1", success: true }),
        makeStoryMetrics({ storyId: "story-2", success: true }),
        makeStoryMetrics({ storyId: "story-3", success: true }),
      ],
      storiesTotal: 3,
      outcome: { kind: "passed" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).toBe("passed");
    expect(result.storiesPassed).toBe(result.storiesTotal);
    expect(result.storiesTotal).toBe(3);
    expect(result.storiesPassed).toBe(3);
    expect(result.error).toBeUndefined();
  });

  // Boundary: single-story run still classifies as passed when that one story passes.
  it("AC4 (boundary): single-story contestant classifies as passed when its one story succeeds", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [makeStoryMetrics({ storyId: "only", success: true })],
      storiesTotal: 1,
      outcome: { kind: "passed" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).toBe("passed");
    expect(result.storiesPassed).toBe(1);
    expect(result.storiesTotal).toBe(1);
  });
});

// ── AC-5: At least one unpassed story → status "failed" ───────────────────────

describe("runContestant (AC-5: any failure classification)", () => {
  it("AC5: returns status 'failed' when at least one story is unpassed", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [
        makeStoryMetrics({ storyId: "story-1", success: true }),
        makeStoryMetrics({ storyId: "story-2", success: false }),
      ],
      storiesTotal: 2,
      outcome: { kind: "failed" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).toBe("failed");
    expect(result.storiesPassed).toBe(1);
    expect(result.storiesTotal).toBe(2);
  });

  // Boundary: zero stories passed → still 'failed', not 'passed'.
  it("AC5 (boundary): classifies as 'failed' when every story is unpassed", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [
        makeStoryMetrics({ storyId: "story-1", success: false }),
        makeStoryMetrics({ storyId: "story-2", success: false }),
      ],
      storiesTotal: 2,
      outcome: { kind: "failed" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).toBe("failed");
    expect(result.storiesPassed).toBe(0);
  });
});

// ── AC-6: Pipeline throws mid-run → status 'dnf-crashed' ──────────────────────

describe("runContestant (AC-6: pipeline crash classification)", () => {
  it("AC6: returns status 'dnf-crashed' with non-empty error and does not re-throw", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => {
      throw new Error("kaboom");
    });

    let result: ContestantResult | unknown;
    let didThrow = false;
    try {
      result = await withDeps(
        {
          worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
          runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
        },
        () => runContestant("claude", baseOptions()),
      );
    } catch (err) {
      didThrow = true;
      result = err;
    }

    expect(didThrow).toBe(false);
    expect(result.status).toBe("dnf-crashed");
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });

  // Boundary: a thrown non-Error value still produces dnf-crashed with a stringified error.
  it("AC6 (boundary): non-Error throws are stringified into the error field", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => {
      throw "string-only failure";
    });

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).toBe("dnf-crashed");
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });
});

// ── AC-7: Cost-limit abort → status 'cost-limit' ──────────────────────────────

describe("runContestant (AC-7: cost-limit abort classification)", () => {
  it("AC7: returns status 'cost-limit' when the pipeline signals a per-contestant cost-limit abort", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [makeStoryMetrics({ success: false })],
      storiesTotal: 1,
      outcome: { kind: "cost-limit" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions({ maxCostUsd: 5 })),
    );

    expect(result.status).toBe("cost-limit");
  });

  // Boundary: cost-limit outcome must NOT be downgraded to 'failed'.
  it("AC7 (boundary): cost-limit outcome is distinct from 'failed' even when stories did not pass", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [makeStoryMetrics({ success: false })],
      storiesTotal: 1,
      outcome: { kind: "cost-limit" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).not.toBe("failed");
    expect(result.status).toBe("cost-limit");
  });
});

// ── AC-8: Metrics → ContestantResult mapping ──────────────────────────────────

describe("runContestant (AC-8: metrics aggregation)", () => {
  it("AC8: maps total cost → costUsd, total durationMs → wallTimeMs, attempts → tierEscalations", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [
        makeStoryMetrics({
          storyId: "story-1",
          success: true,
          cost: 1.5,
          durationMs: 2000,
          attempts: 1,
        }),
        makeStoryMetrics({
          storyId: "story-2",
          success: true,
          cost: 2.25,
          durationMs: 3500,
          attempts: 3,
        }),
      ],
      storiesTotal: 2,
      outcome: { kind: "passed" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.costUsd).toBeCloseTo(3.75, 5);
    expect(result.wallTimeMs).toBe(5500);
    expect(result.tierEscalations).toBe(4);
  });

  // Boundary: zero metrics → zero cost / zero wallTime / zero escalations.
  it("AC8 (boundary): returns zero cost, zero wallTime, and zero tierEscalations when no stories ran", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [],
      storiesTotal: 0,
      outcome: { kind: "passed" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.costUsd).toBe(0);
    expect(result.wallTimeMs).toBe(0);
    expect(result.tierEscalations).toBe(0);
  });
});

// ── AC-9: Pipeline bounds exhausted → status 'timeout' ────────────────────────

describe("runContestant (AC-9: bounds-exhausted / timeout classification)", () => {
  it("AC9: returns status 'timeout' when the pipeline signals a bounds-exhausted outcome without passing", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [makeStoryMetrics({ success: false })],
      storiesTotal: 1,
      outcome: { kind: "timeout" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).toBe("timeout");
  });

  // Boundary: timeout must NOT be downgraded to 'failed' or 'passed'.
  it("AC9 (boundary): timeout outcome is distinct from 'failed' and 'passed'", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      storyMetrics: [makeStoryMetrics({ success: false })],
      storiesTotal: 1,
      outcome: { kind: "timeout" },
    }));

    const result = await withDeps(
      {
        worktreeManager: wt as unknown as Pick<WorktreeManager, "create" | "remove">,
        runPipeline: pipeline.fn as unknown as typeof _contestantDeps.runPipeline,
      },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).not.toBe("passed");
    expect(result.status).not.toBe("failed");
    expect(result.status).toBe("timeout");
  });
});
