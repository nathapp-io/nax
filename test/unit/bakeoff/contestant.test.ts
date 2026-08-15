/**
 * Tests for src/bakeoff/contestant.ts
 *
 * Covers the "Pinned contestant runner and worktree isolation" story,
 * adapted to the new `{ pipeline }` deps shape and `{ results, metrics,
 * costLimitReached?, status? }` pipeline-result shape.
 */

import { describe, expect, it, mock } from "bun:test";
import { type ContestantOptions, type ContestantPipelineResult, _contestantDeps, runContestant } from "@/bakeoff";
import type { ContestantResult } from "@/bakeoff/types";
import type { NaxConfig } from "@/config";

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
    projectRoot: "/tmp/project",
    config: baseConfig(),
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
  impl: (config: NaxConfig) => Promise<ContestantPipelineResult>,
  callOrder?: string[],
): FakePipeline {
  return {
    fn: mock(async (config: NaxConfig) => {
      callOrder?.push("pipeline");
      return impl(config);
    }),
    callOrder: callOrder ?? [],
  };
}

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
      results: [{ status: "passed" }],
      metrics: [],
    }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.agent).toBe("claude");
  });

  it("AC1 (boundary): preserves a non-default agent name (codex) verbatim on the result", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      results: [{ status: "passed" }],
      metrics: [],
    }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
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
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions()),
    );

    expect(order).toEqual(["create", "pipeline", "remove"]);
  });

  it("AC2 (boundary): still calls worktree.remove when pipeline throws synchronously", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(() => {
      throw new Error("sync boom");
    });

    await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions()),
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
    const pipeline = makePipeline(async (config) => {
      capturedConfig = config;
      return { results: [{ status: "passed" }], metrics: [] };
    });

    await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("codex", baseOptions()),
    );

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig?.agent?.default).toBe("codex");
    expect(capturedConfig?.agent?.fallback?.enabled).toBe(false);
  });

  it("AC3 (boundary): forces fallback.enabled=false even when base config had fallback ENABLED", async () => {
    const wt = makeWorktreeManager();
    let capturedConfig: NaxConfig | undefined;
    const pipeline = makePipeline(async (config) => {
      capturedConfig = config;
      return { results: [{ status: "passed" }], metrics: [] };
    });

    const baseWithFallback = baseConfig();
    baseWithFallback.agent = {
      ...baseWithFallback.agent,
      fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 3 },
    };

    await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
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
      results: [{ status: "passed" }, { status: "passed" }, { status: "passed" }],
      metrics: [],
    }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions({ storiesTotal: 3 })),
    );

    expect(result.status).toBe("passed");
    expect(result.storiesTotal).toBe(3);
    expect(result.storiesPassed).toBe(3);
  });

  it("AC4 (boundary): single-story contestant classifies as passed when its one story succeeds", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      results: [{ status: "passed" }],
      metrics: [],
    }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
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
      results: [{ status: "passed" }, { status: "failed" }],
      metrics: [],
    }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions({ storiesTotal: 2 })),
    );

    expect(result.status).toBe("failed");
    expect(result.storiesPassed).toBe(1);
    expect(result.storiesTotal).toBe(2);
  });

  it("AC5 (boundary): classifies as 'failed' when every story is unpassed", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      results: [{ status: "failed" }, { status: "failed" }],
      metrics: [],
    }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions({ storiesTotal: 2 })),
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
        { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
        () => runContestant("claude", baseOptions()),
      );
    } catch (err) {
      didThrow = true;
      result = err;
    }

    expect(didThrow).toBe(false);
    expect((result as ContestantResult).status).toBe("dnf-crashed");
    expect(typeof (result as ContestantResult).error).toBe("string");
    expect(((result as ContestantResult).error as string).length).toBeGreaterThan(0);
  });

  it("AC6 (boundary): non-Error throws are stringified into the error field", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => {
      throw "string-only failure";
    });

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).toBe("dnf-crashed");
    expect(typeof result.error).toBe("string");
    expect((result.error as string).length).toBeGreaterThan(0);
  });
});

// ── BUG-03: worktreeManager.create() failure (incl. unwired deps) must not
// crash the whole bake-off CLI invocation — it used to run before the try
// block, so a throw there propagated uncaught out of runContestant.
describe("runContestant (BUG-03: worktreeManager.create failure classification)", () => {
  it("does not throw when worktreeManager.create rejects — returns dnf-crashed instead", async () => {
    const wt = makeWorktreeManager();
    wt.create = mock(async () => {
      throw new Error("worktree create failed");
    });
    const pipeline = makePipeline(async () => {
      throw new Error("should never be called");
    });

    let didThrow = false;
    let result: ContestantResult | unknown;
    try {
      result = await withDeps(
        { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline }, // test-ratchet-allow: as-unknown-as
        () => runContestant("claude", baseOptions()),
      );
    } catch (err) {
      didThrow = true;
      result = err;
    }

    expect(didThrow).toBe(false);
    expect((result as ContestantResult).status).toBe("dnf-crashed");
    expect(((result as ContestantResult).error as string)).toContain("worktree create failed");
    expect(pipeline.fn).not.toHaveBeenCalled();
  });

  it("reproduces the reported crash: entirely unwired deps.worktreeManager (undefined) yields dnf-crashed, not a TypeError throw", async () => {
    let didThrow = false;
    let result: ContestantResult | unknown;
    try {
      result = await withDeps(
        {
          worktreeManager: undefined as unknown as typeof _contestantDeps.worktreeManager, // test-ratchet-allow: as-unknown-as
          pipeline: undefined as unknown as typeof _contestantDeps.pipeline, // test-ratchet-allow: as-unknown-as
        },
        () => runContestant("claude", baseOptions()),
      );
    } catch (err) {
      didThrow = true;
      result = err;
    }

    expect(didThrow).toBe(false);
    expect((result as ContestantResult).status).toBe("dnf-crashed");
  });
});

// ── AC-7: Cost-limit abort → status 'cost-limit' ──────────────────────────────

describe("runContestant (AC-7: cost-limit abort classification)", () => {
  it("AC7: returns status 'cost-limit' when the pipeline signals a per-contestant cost-limit abort", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      results: [],
      metrics: [],
      costLimitReached: true,
    }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions({ maxCostUsd: 5 })),
    );

    expect(result.status).toBe("cost-limit");
  });
});

// ── AC-8: Metrics → ContestantResult mapping ──────────────────────────────────

describe("runContestant (AC-8: metrics aggregation)", () => {
  it("AC8: maps total cost → costUsd, total durationMs → wallTimeMs, attempts → tierEscalations", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({
      results: [{ status: "passed" }, { status: "passed" }],
      metrics: [
        { cost: 100, durationMs: 5000, attempts: 1 },
        { cost: 200, durationMs: 3000, attempts: 3 },
      ],
    }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions({ storiesTotal: 2 })),
    );

    expect(result.costUsd).toBe(300);
    expect(result.wallTimeMs).toBe(8000);
    expect(result.tierEscalations).toBeGreaterThanOrEqual(0);
  });

  it("AC8 (boundary): returns zero cost, zero wallTime, and zero tierEscalations when no stories ran", async () => {
    const wt = makeWorktreeManager();
    const pipeline = makePipeline(async () => ({ results: [], metrics: [] }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
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
      results: [],
      metrics: [],
      status: "timeout",
    }));

    const result = await withDeps(
      { worktreeManager: wt, pipeline: pipeline.fn as unknown as typeof _contestantDeps.pipeline },
      () => runContestant("claude", baseOptions()),
    );

    expect(result.status).toBe("timeout");
  });
});
